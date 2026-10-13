require('dotenv').config({ quiet: true });

const http = require('http');
const express = require('express');
const app = express();
const server = http.createServer(app);

//importo middlewares
const tieneSesion = require('./middlewares/tieneSesion');
const obtenerRawBody = require('./middlewares/obtenerRawBody');
const middlewareSesion = require('./middlewares/middlewareSession');
const createRateLimit = require('./middlewares/createRateLimit');

// importo los servicios
const whatsappService = require('./services/whatsapp');
const orquestadorService = require('./services/orquestador');
const socketsService = require('./services/sockets');
const mongoService = require('./services/mongo');
const usuarioService = require('./services/usuarios');
const botService = require('./services/bot');
const accionesExternasService = require('./services/accionesExternas');

const cUsuarios = require('./models/usuarios');
const cConversaciones = require('./models/conversacion');
const cMensajes = require('./models/mensaje');
const metricasService = require('./services/metricas');
const promptsService = require('./services/prompts');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

//creo la carpeta uploads si no existe
if( !fs.existsSync(path.join(__dirname, '/uploads'))) fs.mkdirSync(path.join(__dirname, '/uploads'));
if( !fs.existsSync(path.join(__dirname, '/uploads/audio'))) fs.mkdirSync(path.join(__dirname, '/uploads/audio'));
if( !fs.existsSync(path.join(__dirname, '/uploads/imagenes'))) fs.mkdirSync(path.join(__dirname, '/uploads/imagenes'));

// Midleware necesario para validar mensajes de WhatsApp entrantes
app.use(express.json({ verify: obtenerRawBody }));

app.use(middlewareSesion);

//inicializo el servicio de sockets
socketsService.inicializar(server, middlewareSesion);

// Ruta index
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname,"public",'index.html'));
});

//rutas publicas (para el frontend)
app.use(express.static(path.join(__dirname, 'public')));

//rutas de usuarios
app.post('/sesion/iniciar', createRateLimit(), usuarioService.iniciarSesion);
app.post('/sesion/cerrar', usuarioService.cerrarSesion);
app.get('/sesion/cerrar', usuarioService.cerrarSesion);


// Verifica si hay una sesión activa y si el usuario está habilitado.
app.get('/sesion/activa', async (req, res) => {
    try{
        const sesionActiva = !!req.session.usuarioId && !!await cUsuarios.exists({ _id: req.session.usuarioId, habilitado: true });
        res.json(sesionActiva);
    }catch(error){
        console.error(error);
        res.status(500).json({ error: 'No se pudo verificar la sesión.' });
    }
});

// obtiene las conversaciones (puede ordenar por pendientes y filtrar por no leidas)
app.get('/conversaciones/obtener', tieneSesion, async (req, res)=>{
    try{
        const {noLeidas} = req.query;
        let query = noLeidas === 'true' || noLeidas === '1'
            ? { 'ultimoMensaje.deClienteParaSistema': true, 'ultimoMensaje.fechaLeida': null } : {};
        if (req.query.orden === 'pendientes') {
            const pendientes = { $or: [{ accionesExternasRequeridas: { $elemMatch: { aceptada: { $ne: true } } } }, { 'ultimoMensaje.deClienteParaSistema': true }] };
            query = Object.keys(query).length ? { $and: [query, pendientes] } : pendientes;
        }
        const conversaciones = await cConversaciones.aggregate([
            { $match: query },
            { $addFields: { __pendiente: { $anyElementTrue: [{ $map: {
                input: { $ifNull: ['$accionesExternasRequeridas', []] }, as: 'accion', in: { $ne: ['$$accion.aceptada', true] },
            } }] } } },
            { $sort: { __pendiente: -1, updatedAt: -1, _id: -1 } },
            { $limit: 300 }, { $project: { __pendiente: 0 } },
        ]);
        res.json(conversaciones);
    }catch(error){
        console.error(error);
        res.status(500).json({ error: 'Error al obtener las conversaciones' });
    }
});

// obtiene los mensajes de una conversación (paginado)
app.get('/conversacion/mensajes', tieneSesion, async (req, res)=>{
    try{
        const {conversacionId, pagina} = req.query;
        const numeroPagina = Number(pagina || 0);
        if (!mongoose.isObjectIdOrHexString(conversacionId) || !Number.isSafeInteger(numeroPagina) || numeroPagina < 0) {
            return res.status(400).json({ error: 'Conversación o página inválida.' });
        }
        const mensajesPorPagina = 50;
        const skip = numeroPagina * mensajesPorPagina;
        const mensajes = await cMensajes
            .find({ conversacionId: conversacionId })
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(mensajesPorPagina)
        res.json(mensajes);
    }catch(error){
        console.error(error);
        res.status(500).json({ error: 'Error al obtener los mensajes' });
    }
});

function cambiarEstadoBot(botActivo) {
    return async (req, res) => {
        try {
            const { conversacionId } = req.body || {};
            if (!mongoose.isObjectIdOrHexString(conversacionId)) {
                return res.status(400).json({ error: 'Indicá una conversación válida.' });
            }
            const conversacion = await cConversaciones.findOneAndUpdate({ _id: conversacionId },
                { $set: { botActivo } }, { returnDocument: 'after', runValidators: true });
            if (!conversacion) return res.status(404).json({ error: 'Conversación no encontrada.' });
            if (!botActivo) await botService.cancelarEspera(conversacionId);
            await socketsService.notificarCambios(conversacion);
            res.json(conversacion);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'No se pudo cambiar el estado del bot.' });
        }
    };
}
app.post('/conversaciones/habilitar-bot', tieneSesion, cambiarEstadoBot(true));
app.post('/conversaciones/deshabilitar-bot', tieneSesion, cambiarEstadoBot(false));

app.post('/conversaciones/aceptar-accion-externa', tieneSesion, async (req, res) => {
    try {
        const { conversacionId, accionId } = req.body || {};
        if (!mongoose.isObjectIdOrHexString(conversacionId) || !mongoose.isObjectIdOrHexString(accionId)) {
            return res.status(400).json({ error: 'Indicá una conversación y una intervención válidas.' });
        }
        const conversacion = await accionesExternasService.aceptar(conversacionId, accionId);
        if (!conversacion) return res.status(404).json({ error: 'Intervención no encontrada.' });
        await socketsService.notificarCambios(conversacion);
        res.json(conversacion);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'No se pudo marcar la intervención como atendida.' });
    }
});

// Devuelve las métricas de un mes UTC. ?anio=YYYY&mes=M permite elegir el período;
// cada parámetro omitido toma el año o mes actual del reloj del servidor.
app.get('/metricas/mes', tieneSesion, async (req, res) => {
    try {
        const ahora = new Date();
        const { anio, mes } = req.query;
        if ((anio !== undefined && (typeof anio !== 'string' || !/^[0-9]{1,4}$/.test(anio) || Number(anio) < 1)) ||
            (mes !== undefined && (typeof mes !== 'string' || !/^[0-9]{1,2}$/.test(mes) || Number(mes) < 1 || Number(mes) > 12))) {
            return res.status(400).json({ error: 'Indicá un año y un mes válidos.' });
        }
        const fecha = new Date(0);
        fecha.setUTCFullYear(anio === undefined ? ahora.getUTCFullYear() : Number(anio),
            (mes === undefined ? ahora.getUTCMonth() + 1 : Number(mes)) - 1, 1);
        res.set('Cache-Control', 'no-store');
        res.json(await metricasService.obtenerMetricasMensuales(fecha));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'No se pudieron obtener las métricas del mes.' });
    }
});

// Obtiene los promps del sistema
app.get('/prompts/obtener', tieneSesion, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        res.json(await promptsService.listar());
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'No se pudieron cargar los prompts.' });
    }
});

//sobre-escribe un prompt del sistema
app.post('/prompts/guardar', tieneSesion, async (req, res) => {
    try {
        const prompt = await promptsService.guardar(req.body?.id, req.body?.contenido, req.body?.version);
        res.set('Cache-Control', 'no-store');
        res.json(prompt);
    } catch (error) {
        if (!error.status) console.error(error);
        res.status(error.status || 500).json({ error: error.status ? error.message : 'No se pudo guardar el prompt.' });
    }
});

// Los usuarios habilitados del panel son los administradores; solo ellos pueden leer los archivos.
const opcionesUploads = {
    setHeaders: res => {
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
    },
};
app.use('/uploads/audio', tieneSesion, express.static(path.join(__dirname, 'uploads', 'audio'), opcionesUploads));
app.use('/uploads/imagenes', tieneSesion, express.static(path.join(__dirname, 'uploads', 'imagenes'), opcionesUploads));

// Whatsapp usa esta ruta para enviar mensajes entrantes a nuestro servidor, y para verificar el webhook.
app.post('/whatsapp/webhook', whatsappService.recibirMensajeWebhook);

// Whatsapp usa esta ruta para verificar el webhook. Se envía un GET con un token de verificación.
app.get('/whatsapp/webhook', whatsappService.configurarWebhook);



//inicia mongo y el servidor http
async function iniciar(){
    const mongo = await mongoService.connectDB();

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`WhatsApp OpenAI service is running on port http://localhost:${PORT}`);
    });
}

// Iniciamos el servidor
iniciar();
