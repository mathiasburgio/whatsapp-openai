require('dotenv').config({ quiet: true });

const http = require('http');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const app = express();
const server = http.createServer(app);
const whatsappService = require('./services/whatsapp');
const orquestadorService = require('./services/orquestador');
const socketsService = require('./services/sockets');
const mongoService = require('./services/mongo');
const usuarioService = require('./services/usuarios');
const cUsuarios = require('./models/usuarios');
const cConversaciones = require('./models/conversacion');
const cMensajes = require('./models/mensaje');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

//creo la carpeta uploads si no existe
if( !fs.existsSync(path.join(__dirname, '/uploads'))) fs.mkdirSync(path.join(__dirname, '/uploads'));
if( !fs.existsSync(path.join(__dirname, '/uploads/audio'))) fs.mkdirSync(path.join(__dirname, '/uploads/audio'));
if( !fs.existsSync(path.join(__dirname, '/uploads/imagenes'))) fs.mkdirSync(path.join(__dirname, '/uploads/imagenes'));

// Midleware necesario para validar mensajes de WhatsApp entrantes
app.use(express.json({
    verify: (req, res, body) => {
        req.rawBody = Buffer.from(body);
    },
}));

const middlewareSesion = session({
    name: 'whatsapp_openai_session',
    secret: process.env.SESSION_SECRET || 'default_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000,
    },
});
app.use(middlewareSesion);
socketsService.inicializar(server, middlewareSesion);

async function tieneSesion(req, res){
    if (!req.session.usuarioId || !await cUsuarios.exists({ _id: req.session.usuarioId, habilitado: true })) {
        res.status(401).json({ error: 'Iniciá sesión para continuar.' });
        return false;
    }
    return true;
}
function crearRateLimit(windowMs=15 * 60 * 1000, limit=5, message={ error: 'Demasiados intentos. Volvé a intentar más tarde.' }) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message,
    });
}
// Registramos las rutas después del middleware de sesión.

// Rutas de la aplicación WEB
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname,"public",'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.post("/iniciar-sesion", crearRateLimit(), usuarioService.iniciarSesion);
app.post("/cerrar-sesion", usuarioService.cerrarSesion);

app.get('/verificar-sesion', async (req, res) => {
    try{
        const sesionActiva = !!req.session.usuarioId && !!await cUsuarios.exists({ _id: req.session.usuarioId, habilitado: true });
        res.json({ sesionActiva });
    }catch(error){
        console.error(error);
        res.status(500).json({ error: 'No se pudo verificar la sesión.' });
    }
});

app.get("/conversaciones", async (req, res)=>{
    try{
        if(!await tieneSesion(req, res)) return;

        const {noLeidas} = req.query;
        const query = noLeidas === 'true' || noLeidas === '1'
            ? { 'ultimoMensaje.deClienteParaSistema': true, 'ultimoMensaje.fechaLeida': null } : {};
        const conversaciones = await cConversaciones
            .find(query)
            .sort({ updatedAt: -1, _id: -1 })
            .limit(300)
        res.json(conversaciones);
    }catch(error){
        console.error(error);
        res.status(500).json({ error: 'Error al obtener las conversaciones' });
    }
});

app.get("/mensajes", async (req, res)=>{
    try{
        if(!await tieneSesion(req, res)) return;
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

// Registramos las rutas después del middleware de sesión.
app.post('/whatsapp/webhook', whatsappService.recibirMensajeWebhook);
app.get('/whatsapp/webhook', whatsappService.configurarWebhook);

async function iniciar(){
    if (!process.env.SESSION_SECRET) throw new Error('Falta definir SESSION_SECRET en las variables de entorno.');
    const mongo = await mongoService.connectDB();

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`WhatsApp OpenAI service is running on port http://localhost:${PORT}`);
    });
}

// Iniciamos el servidor
iniciar();
