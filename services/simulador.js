const express = require('express');
const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');
const orquestador = require('./orquestador');
const sockets = require('./sockets');
const colaMensajes = require('./colaMensajes');
const fs = require('node:fs/promises');
const path = require('node:path');
let operacionTestPendiente = Promise.resolve();

// Un único contacto fijo compartido por los administradores del panel.
const CONVERSACION_TEST_ID = '000000000000000000000001';
const DEMORAS_PERMITIDAS = [1, 5, 10, 15, 20];
const formatosPermitidos = {
    imagen: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    audio: ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/x-m4a'],
};

async function obtenerConversacionTest() {
    return Conversacion.findOneAndUpdate({ _id: CONVERSACION_TEST_ID, canal: 'simulador' }, {
        $setOnInsert: { nombre: 'Test', telefono: 'test', canal: 'simulador', botActivo: true },
    }, { upsert: true, returnDocument: 'after', runValidators: true });
}

// Ordena recepción y limpieza para que una carga en curso termine antes de borrar sus archivos.
function serializarOperacionTest(operacion) {
    const actual = operacionTestPendiente.then(operacion);
    operacionTestPendiente = actual.catch(function continuarTrasErrorTest() {});
    return actual;
}

function comprobarVersionTest(version, conversacion) {
    if (!Number.isSafeInteger(version) || version < 0) {
        throw Object.assign(new Error('Indicá una versión válida de la prueba.'), { status: 400 });
    }
    if (version !== conversacion.versionSimulador) {
        throw Object.assign(new Error('La conversación de Test se reinició. Volvé a enviar el mensaje en la prueba actual.'),
            { status: 409, conversacion });
    }
}

// Elimina únicamente adjuntos de Test, con rutas contenidas en uploads y sin borrado recursivo.
async function eliminarAdjuntosTest(mensajes) {
    for (const mensaje of mensajes) {
        for (const [campo, subcarpeta] of [['imagenArchivo', 'imagenes'], ['audioArchivo', 'audio']]) {
            const nombre = mensaje[campo];
            if (!nombre) continue;
            const carpeta = path.resolve(__dirname, '..', 'uploads', subcarpeta);
            const archivo = path.resolve(carpeta, nombre);
            if (path.dirname(archivo) !== carpeta || path.basename(archivo) !== nombre) {
                throw new Error('Un adjunto de Test tiene un nombre inválido. No se eliminó ese archivo.');
            }
            try { await fs.unlink(archivo); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
}

async function reiniciarConversacionTest(version) {
    const conversacion = await obtenerConversacionTest();
    comprobarVersionTest(version, conversacion);
    await Conversacion.updateOne({ _id: conversacion._id, canal: 'simulador' }, { $set: { botActivo: false } });
    await colaMensajes.cancelarYEsperarProcesamiento(conversacion._id);
    // Drenar el envío manual/automático que ya hubiera entrado en la sección de guardado.
    return require('./envios').serializar(async function borrarContextoTest() {
        const filtro = { conversacionId: conversacion._id };
        const mensajes = await Mensaje.find(filtro).select('imagenArchivo audioArchivo').lean();
        await eliminarAdjuntosTest(mensajes);
        await Mensaje.deleteMany(filtro);
        const nuevaConversacion = await Conversacion.findOneAndReplace(
            { _id: conversacion._id, canal: 'simulador' },
            { nombre: 'Test', telefono: 'test', canal: 'simulador', botActivo: true, versionSimulador: version + 1 },
            { returnDocument: 'after', runValidators: true },
        );
        await sockets.notificarCambios(nuevaConversacion);
        return nuevaConversacion;
    });
}

function validarArchivoSimulado(archivo) {
    if (archivo === undefined || archivo === null) return undefined;
    const { tipo, mimeType, base64, duracionSegundos } = archivo;
    const limite = tipo === 'imagen' ? 5_000_000 : 15_000_000;
    if (!['imagen', 'audio'].includes(tipo) || !formatosPermitidos[tipo].includes(mimeType) || typeof base64 !== 'string'
        || !base64.length || base64.length > Math.ceil(limite / 3) * 4
        || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        throw Object.assign(new Error('Adjuntá una imagen de hasta 5 MB o un audio compatible de hasta 15 MB.'), { status: 400 });
    }
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length || buffer.length > limite) {
        throw Object.assign(new Error('El archivo supera el tamaño permitido.'), { status: 400 });
    }
    if (tipo === 'audio' && (typeof duracionSegundos !== 'number' || !Number.isFinite(duracionSegundos)
        || duracionSegundos <= 0 || duracionSegundos > 120)) {
        throw Object.assign(new Error('La grabación debe durar entre 1 y 120 segundos.'), { status: 400 });
    }
    return { tipo, mimeType, buffer, duracionSegundos };
}

async function abrirConversacionTest(req, res, next) {
    try {
        const conversacion = await serializarOperacionTest(obtenerConversacionTest);
        await sockets.notificarCambios(conversacion);
        res.set('Cache-Control', 'no-store').json(conversacion);
    } catch (error) { next(error); }
}

async function recibirMensajeTest(req, res, next) {
    try {
        const { contenido = '', segundosEspera, archivo, versionSimulador } = req.body || {};
        if (typeof contenido !== 'string' || contenido.length > 4096 || !DEMORAS_PERMITIDAS.includes(segundosEspera)) {
            return res.status(400).json({ error: 'Indicá un texto de hasta 4096 caracteres y una espera de 1, 5, 10, 15 o 20 segundos.' });
        }
        const adjunto = validarArchivoSimulado(archivo);
        if (!contenido.trim() && !adjunto) return res.status(400).json({ error: 'Escribí un texto, adjuntá una imagen o grabá un audio.' });
        const resultado = await serializarOperacionTest(async function recibirMensajeEnPruebaActual() {
            const conversacion = await obtenerConversacionTest();
            comprobarVersionTest(versionSimulador, conversacion);
            const recibido = await orquestador.recibirMensajeSimulado(conversacion._id, contenido.trim(), adjunto, segundosEspera);
            return { conversacion: await Conversacion.findById(conversacion._id), mensaje: recibido.mensaje };
        });
        res.set('Cache-Control', 'no-store').status(201).json(resultado);
    } catch (error) { next(error); }
}

async function limpiarConversacionTest(req, res, next) {
    try {
        const conversacion = await serializarOperacionTest(function reiniciarPruebaEnOrden() {
            return reiniciarConversacionTest(req.body?.versionSimulador);
        });
        res.set('Cache-Control', 'no-store').json({ conversacion });
    } catch (error) {
        if (!error.status) {
            try { error.conversacion = await Conversacion.findById(CONVERSACION_TEST_ID); }
            catch { /* Conserva el error original si MongoDB no está disponible. */ }
        }
        next(error);
    }
}

function responderErrorSimulador(error, req, res, next) {
    if (res.headersSent) return next(error);
    if (!error.status || error.status >= 500) console.error('Error del simulador:', error);
    const status = error.status || 500;
    res.status(status).json({ error: status === 413 ? 'El archivo supera el tamaño permitido.'
        : status < 500 ? error.message : 'No se pudo completar la operación de Test. Revisá la conversación antes de volver a intentarlo.',
        ...(error.conversacion ? { conversacion: error.conversacion } : {}),
    });
}

const router = express.Router();
router.post('/abrir', abrirConversacionTest);
router.post('/mensajes', express.json({ limit: '22mb' }), recibirMensajeTest);
router.post('/limpiar', express.json({ limit: '1kb' }), limpiarConversacionTest);
router.use(responderErrorSimulador);

module.exports = { router, serializarOperacionTest };
