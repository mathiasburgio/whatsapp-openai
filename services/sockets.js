const { Server } = require('socket.io');
const mongoose = require('mongoose');
const Usuario = require('../models/usuarios');
const orquestador = require('./orquestador');

let io;

function inicializar(server, middlewareSesion) {
    io = new Server(server, {
        allowRequest: (req, responder) => {
            try {
                const origen = req.headers.origin;
                responder(null, !origen || new URL(origen).host === req.headers.host);
            } catch {
                responder(null, false);
            }
        },
    });
    io.engine.use(middlewareSesion);
    io.use(async (socket, siguiente) => {
        try {
            if (!await validarSesion(socket)) {
                const error = new Error('Iniciá sesión para continuar.');
                error.data = { sesionInactiva: true };
                return siguiente(error);
            }
            siguiente();
        } catch {
            siguiente(new Error('No se pudo verificar la sesión.'));
        }
    });
    io.on('connection', socket => {
        socket.on('enviar-mensaje', (datos, responder) => recibirMensaje(socket, datos, responder));
    });
    return io;
}

//valida que el socket conectado tenga una sesion valida
async function validarSesion(socket) {
    const req = socket.request;
    if (!req.session?.usuarioId) return false;
    // Recargamos la sesión para detectar cierres de sesión y vencimientos.
    const existeSesion = await new Promise(resolve => req.session.reload(error => resolve(!error)));
    if (!existeSesion || !mongoose.isObjectIdOrHexString(req.session.usuarioId)) return false;
    return !!await Usuario.exists({ _id: req.session.usuarioId, habilitado: true });
}

//cuando llega un whatsapp pasa por esto
async function recibirMensaje(socket, datos, responder) {
    if (typeof responder !== 'function') responder = () => {};
    try {
        if (!await validarSesion(socket)) {
            responder({ error: 'Iniciá sesión para continuar.', sesionInactiva: true });
            socket.disconnect(true);
            return;
        }
        const { conversacionId, contenido } = datos || {};
        if (!mongoose.isObjectIdOrHexString(conversacionId) || typeof contenido !== 'string' || !contenido.trim() || contenido.trim().length > 4096) {
            return responder({ error: 'Indicá una conversación válida y un mensaje.' });
        }

        const mensaje = await orquestador.responderMensajePorApiWhataspp(conversacionId, contenido.trim(), { usuarioId: socket.request.session.usuarioId });
        responder({ mensaje });
    } catch (error) {
        console.error(error);
        responder({ error: error.message.includes('límite mensual') ? error.message : 'No se pudo confirmar el envío. Revisá la conversación antes de volver a intentarlo.' });
    }
}

//hace broadcast de los cambios de una conversacion y/o mensaje a todos los sockets conectados
async function notificarCambios(conversacion, mensaje) {
    if (!io) return;
    for (const socket of io.sockets.sockets.values()) {
        try {
            if (!await validarSesion(socket)) {
                socket.disconnect(true);
                continue;
            }
            socket.emit('cambios', { conversacion, mensaje });
        } catch (error) {
            console.error(error);
            socket.disconnect(true);
        }
    }
}

module.exports = { inicializar, notificarCambios };
