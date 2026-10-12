const { Server } = require('socket.io');
const mongoose = require('mongoose');
const Usuario = require('../models/usuarios');

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

async function validarSesion(socket) {
    const req = socket.request;
    if (!req.session?.usuarioId) return false;
    // Recargamos la sesión para detectar cierres de sesión y vencimientos.
    const existeSesion = await new Promise(resolve => req.session.reload(error => resolve(!error)));
    if (!existeSesion || !mongoose.isObjectIdOrHexString(req.session.usuarioId)) return false;
    return !!await Usuario.exists({ _id: req.session.usuarioId, habilitado: true });
}

async function recibirMensaje(socket, datos, responder) {
    if (typeof responder !== 'function') responder = () => {};
    try {
        if (!await validarSesion(socket)) {
            responder({ error: 'Iniciá sesión para continuar.', sesionInactiva: true });
            socket.disconnect(true);
            return;
        }
        const { conversacionId, contenido, solicitudId } = datos || {};
        if (!mongoose.isObjectIdOrHexString(conversacionId) || typeof contenido !== 'string' || !contenido.trim() || contenido.trim().length > 4096
            || typeof solicitudId !== 'string' || !/^[a-f0-9-]{36}$/i.test(solicitudId)) {
            return responder({ error: 'Indicá una conversación válida y un mensaje.' });
        }
        const orquestador = require('./orquestador');
        const mensaje = await orquestador.recibirMensajeVendedor(conversacionId, contenido.trim(), { solicitudId, usuarioId: socket.request.session.usuarioId });
        responder({ mensaje, ...(mensaje.estadoEnvio && mensaje.estadoEnvio !== 'enviado' && { error: mensaje.estadoEnvio === 'fallido'
            ? 'WhatsApp rechazó el envío. Revisá el mensaje y la configuración antes de volver a enviar.'
            : 'El envío sigue pendiente o no pudo confirmarse. Revisá la conversación antes de volver a enviarlo.' }) });
    } catch (error) {
        console.error(error);
        responder({ error: 'No se pudo enviar el mensaje.' });
    }
}

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
