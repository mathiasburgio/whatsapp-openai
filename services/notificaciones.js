const express = require('express');
const path = require('node:path');
const webpush = require('web-push');
const { Claves, Conexion, Aviso } = require('../models/notificaciones');
const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');
const tieneSesion = require('../middlewares/tieneSesion');
const router = express.Router();

async function crearClavesVapid(origen) {
    const existentes = await Claves.findById('vapid');
    if (existentes) return existentes;
    return Claves.findOneAndUpdate({ _id: 'vapid' }, {
        $setOnInsert: { ...webpush.generateVAPIDKeys(), subject: process.env.VAPID_SUBJECT || origen.replace(/^http:/, 'https:') },
    }, { upsert: true, returnDocument: 'after' });
}

async function crearTokenConexion(req, res) {
    const nombre = typeof req.body?.nombre === 'string' ? req.body.nombre.trim() : '';
    if (!nombre || nombre.length > 100) return res.status(400).json({ error: 'Ingresá un nombre de hasta 100 caracteres.' });
    const origen = (process.env.NOTIFICACIONES_URL_PUBLICA || req.get('origin')
        || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    await crearClavesVapid(origen);
    const conexion = await Conexion.create({ nombre, venceEn: new Date(Date.now() + 60 * 60 * 1000) });
    res.json({ token: conexion._id, venceEn: conexion.venceEn,
        url: `${origen}/notificaciones/suscribirse?token=${conexion._id}` });
}

// Solo el panel puede consultar las conexiones; nunca devuelve datos privados de Web Push.
async function listarConexiones(req, res) {
    const conexiones = await Conexion.find().select('nombre venceEn utilizadaEn suscripcion createdAt').sort({ createdAt: -1 }).lean();
    const ahora = Date.now();
    const origen = (process.env.NOTIFICACIONES_URL_PUBLICA || req.get('origin')
        || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    res.json(conexiones.map(function describirConexion(conexion) {
        const estado = conexion.suscripcion ? 'activa' : conexion.utilizadaEn ? 'inactiva'
            : new Date(conexion.venceEn).getTime() > ahora ? 'pendiente' : 'vencida';
        return { id: conexion._id, nombre: conexion.nombre || 'Sin nombre (anterior)', estado, venceEn: conexion.venceEn,
            ...(estado === 'pendiente' ? { url: `${origen}/notificaciones/suscribirse?token=${conexion._id}` } : {}) };
    }));
}

async function quitarConexion(req, res) {
    const conexion = await Conexion.findById(req.params.id).lean();
    if (!conexion) return res.status(404).json({ error: 'La suscripción ya no existe.' });
    // Invitaciones antiguas pueden compartir el mismo navegador: quitarlas evita que siga recibiendo avisos.
    if (conexion.suscripcion?.endpoint) await Conexion.deleteMany({ 'suscripcion.endpoint': conexion.suscripcion.endpoint });
    else await Conexion.deleteOne({ _id: conexion._id });
    res.json({ ok: true });
}

async function probarConexion(req, res) {
    const conexion = await Conexion.findById(req.params.id).lean();
    if (!conexion?.suscripcion?.endpoint) return res.status(404).json({ error: 'Esta suscripción no está activa.' });
    const claves = await Claves.findById('vapid');
    if (!claves) return res.status(503).json({ error: 'No están configuradas las notificaciones.' });
    try {
        await webpush.sendNotification(conexion.suscripcion, JSON.stringify({
            titulo: 'Notificación de prueba', cuerpo: 'Las notificaciones de intervención están configuradas en este dispositivo.',
            url: '/panel', tag: 'prueba-notificaciones',
        }), { vapidDetails: { subject: claves.subject, publicKey: claves.publicKey, privateKey: claves.privateKey }, TTL: 60, timeout: 10000 });
        res.json({ ok: true });
    } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
            await Conexion.updateMany({ 'suscripcion.endpoint': conexion.suscripcion.endpoint }, { $unset: { suscripcion: 1 } });
            return res.status(410).json({ error: 'La suscripción venció o fue desactivada en el dispositivo. Generá un enlace nuevo.' });
        }
        console.error('No se pudo enviar la notificación de prueba:', error.message);
        res.status(502).json({ error: 'No se pudo enviar la notificación de prueba. Intentá nuevamente.' });
    }
}

async function obtenerInvitacion(req, res) {
    const conexion = await Conexion.findOne({ _id: req.params.token,
        utilizadaEn: null, venceEn: { $gt: new Date() } });
    if (!conexion) return res.status(410).json({ error: 'El enlace venció o ya fue utilizado. Pedí uno nuevo al administrador.' });
    const claves = await Claves.findById('vapid');
    res.json({ publicKey: claves.publicKey, venceEn: conexion.venceEn });
}

async function suscribirNotificaciones(req, res) {
    const { token, suscripcion } = req.body || {};
    if (typeof token !== 'string' || typeof suscripcion?.endpoint !== 'string'
        || !suscripcion.endpoint.startsWith('https://') || !suscripcion.keys?.p256dh || !suscripcion.keys?.auth) {
        return res.status(400).json({ error: 'Falta una suscripción válida del navegador.' });
    }
    // Una sola escritura: dos personas no pueden consumir el mismo UUID.
    const conexion = await Conexion.findOneAndUpdate({ _id: token,
        utilizadaEn: null, venceEn: { $gt: new Date() } }, {
        $set: { utilizadaEn: new Date(), suscripcion: {
            endpoint: suscripcion.endpoint, keys: { p256dh: suscripcion.keys.p256dh, auth: suscripcion.keys.auth },
        } },
    }, { returnDocument: 'after' });
    if (!conexion) return res.status(410).json({ error: 'El enlace venció o ya fue utilizado. Pedí uno nuevo al administrador.' });
    res.json({ ok: true });
}

// Se llama solamente cuando se agrega una intervención nueva, nunca al volver a leerla.
async function notificarIntervencion(conversacion, accionId) {
    const esSimulacion = conversacion.canal === 'simulador';
    if (esSimulacion && !conversacion.notificacionesSimulador) return;
    const conexiones = await Conexion.find({ suscripcion: { $ne: null } }).lean();
    // Una segunda invitación en el mismo navegador no debe duplicar los avisos.
    const suscripciones = new Map(conexiones.map(conexion => [conexion.suscripcion.endpoint, conexion.suscripcion]));
    if (!suscripciones.size) return;
    const claves = await Claves.findById('vapid');
    const aviso = await Aviso.create({ conversacionId: conversacion._id, accionId,
        ...(esSimulacion ? { versionSimulador: conversacion.versionSimulador || 0 } : {}) });
    const accion = conversacion.accionesExternasRequeridas.find(item => String(item._id) === String(accionId));
    const contenido = JSON.stringify({ titulo: esSimulacion ? 'TEST · Intervención de vendedor' : 'Se requiere intervención de un vendedor',
        cuerpo: (accion?.detalle || 'Hay una consulta pendiente.').slice(0, 160),
        url: `/notificaciones/intervencion/${aviso._id}`, tag: aviso._id });
    const resultados = await Promise.allSettled([...suscripciones.values()].map(async function enviarAviso(suscripcion) {
        try {
            await webpush.sendNotification(suscripcion, contenido, {
                vapidDetails: { subject: claves.subject, publicKey: claves.publicKey, privateKey: claves.privateKey },
                TTL: 60 * 60, timeout: 10000,
            });
        } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) {
                await Conexion.updateMany({ 'suscripcion.endpoint': suscripcion.endpoint }, { $unset: { suscripcion: 1 } });
            } else throw error;
        }
    }));
    for (const resultado of resultados) {
        if (resultado.status === 'rejected') console.error('No se pudo enviar una notificación:', resultado.reason.message);
    }
}

async function obtenerIntervencion(req, res) {
    const aviso = await Aviso.findById(req.params.token);
    if (!aviso) return res.status(404).json({ error: 'Notificación no encontrada.' });
    const conversacion = await Conversacion.findById(aviso.conversacionId)
        .select('nombre telefono canal versionSimulador resumen accionesExternasRequeridas').lean();
    if (!conversacion) return res.status(404).json({ error: 'Conversación no encontrada.' });
    if (aviso.versionSimulador !== undefined && aviso.versionSimulador !== conversacion.versionSimulador) {
        return res.status(410).json({ error: 'Esta prueba se reinició y su contexto ya no está disponible.' });
    }
    const mensajes = await Mensaje.find({ conversacionId: aviso.conversacionId })
        .select('contenido deClienteParaSistema respuestaAutomatica fechaEmitida createdAt')
        .sort({ createdAt: -1, _id: -1 }).limit(20).lean();
    res.json({ conversacion, accionId: aviso.accionId, mensajes: mensajes.reverse() });
}

router.use(function evitarCacheNotificaciones(req, res, next) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
});
router.post('/tokens', tieneSesion, crearTokenConexion);
router.get('/conexiones', tieneSesion, listarConexiones);
router.delete('/conexiones/:id', tieneSesion, quitarConexion);
router.post('/conexiones/:id/probar', tieneSesion, probarConexion);
router.get('/invitaciones/:token', obtenerInvitacion);
router.post('/suscripciones', suscribirNotificaciones);
router.get('/intervencion/:token/datos', obtenerIntervencion);
router.get('/suscribirse', function mostrarAdhesion(req, res) {
    res.sendFile(path.join(__dirname, '..', 'public', 'notificaciones-adhesion.html'));
});
router.get('/intervencion/:token', function mostrarIntervencion(req, res) {
    res.sendFile(path.join(__dirname, '..', 'public', 'notificaciones-intervencion.html'));
});
router.use(function manejarErrorNotificaciones(error, req, res, next) {
    console.error('Error de notificaciones:', error.message);
    res.status(500).json({ error: 'No se pudo completar la operación de notificaciones.' });
});

module.exports = { crearClavesVapid, notificarIntervencion, router };
