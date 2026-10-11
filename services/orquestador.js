const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');
const sockets = require('./sockets');
const openai = require('./openai');
const pendientesPorTelefono = new Map();

function recibirMensajeWhatsapp(telefono, mensaje = '', imagen, audio, datos = {}) {
    if (typeof telefono !== 'string' || !/^\d{5,20}$/.test(telefono)) return Promise.reject(new Error('El teléfono de WhatsApp no es válido.'));
    if (typeof mensaje !== 'string') return Promise.reject(new Error('El mensaje debe ser texto.'));
    // Evita crear dos conversaciones y alterar el orden al recibir varios mensajes del mismo teléfono.
    const anterior = pendientesPorTelefono.get(telefono) || Promise.resolve();
    const actual = anterior.catch(() => {}).then(() => procesarMensajeWhatsapp(telefono, mensaje, imagen, audio, datos));
    pendientesPorTelefono.set(telefono, actual);
    const limpiar = () => { if (pendientesPorTelefono.get(telefono) === actual) pendientesPorTelefono.delete(telefono); };
    actual.then(limpiar, limpiar);
    return actual;
}

async function actualizarConversacion(conversacion, mensaje, tokens) {
    const ultimo = conversacion.ultimoMensaje;
    // Un evento antiguo no debe reemplazar un mensaje más reciente en la vista del panel.
    if (!ultimo || !ultimo.fechaEmitida || new Date(ultimo.fechaEmitida) <= mensaje.fechaEmitida) {
        conversacion.deClienteParaSistema = true;
        conversacion.ultimoMensaje = mensaje.toObject();
    }
    if (tokens) {
        for (const campo of ['entrada', 'salida', 'total']) {
            conversacion.set(`tokens.${campo}`, (conversacion.tokens?.[campo] || 0) + (tokens[campo] || 0));
        }
    }
    await conversacion.save();
    await sockets.notificarCambios(conversacion, mensaje);
}

async function procesarMensajeWhatsapp(telefono, contenido, imagen, audio, datos) {
    const existente = datos.whatsappId ? await Mensaje.findOne({ whatsappId: datos.whatsappId }) : null;
    if (existente && existente.estadoProcesamiento !== 'fallido') return { mensaje: existente, duplicado: true };
    let conversacion = existente ? await Conversacion.findById(existente.conversacionId)
        : await Conversacion.findOne({ telefono }).sort({ updatedAt: -1 });
    if (!conversacion) conversacion = await Conversacion.create({ telefono, nombre: datos.nombre || telefono, deClienteParaSistema: true });
    else if (datos.nombre) conversacion.nombre = datos.nombre;
    const fechaEmitida = datos.fechaEmitida instanceof Date && Number.isFinite(datos.fechaEmitida.getTime()) ? datos.fechaEmitida : new Date();
    let mensaje = existente;
    if (!mensaje) {
        try {
            mensaje = await Mensaje.create({ conversacionId: conversacion._id, whatsappId: datos.whatsappId,
                emisor: telefono, receptor: datos.receptor,
                contenido: contenido || (imagen ? '[Imagen]' : audio ? '[Audio]' : ''), deClienteParaSistema: true, deSistemaParaCliente: false,
                esImagen: !!imagen, esAudio: !!audio, usoLLM: false, estadoProcesamiento: 'pendiente',
                fechaEmitida, crudo: datos.crudo });
        } catch (error) {
            if (error.code === 11000 && datos.whatsappId) return { mensaje: await Mensaje.findOne({ whatsappId: datos.whatsappId }), duplicado: true };
            throw error;
        }
    }
    await actualizarConversacion(conversacion, mensaje);
    let respuestaOpenAi = null;
    const respuestas = [];
    try {
        if (imagen || audio) {
            const whatsapp = require('./whatsapp');
            const opciones = { conversacionId: conversacion._id };
            if (imagen && !mensaje.transcripcionImagen) {
                const archivo = await whatsapp.descargarMedia(imagen.id, { phoneNumberId: datos.phoneNumberId, maxBytes: 5000000 });
                if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(archivo.mimeType)) throw new Error('La imagen de WhatsApp tiene un formato no compatible.');
                const imagenUrl = `data:${archivo.mimeType};base64,${archivo.buffer.toString('base64')}`;
                mensaje.usoLLM = true;
                const respuesta = await openai.procesarImagen(imagenUrl, contenido || 'Describí qué hay en esta imagen.', opciones);
                mensaje.transcripcionImagen = respuesta.resultado;
                respuestas.push(respuesta);
            }
            if (audio && !mensaje.transcripcionAudio) {
                const archivo = await whatsapp.descargarMedia(audio.id, { phoneNumberId: datos.phoneNumberId, maxBytes: 15000000 });
                mensaje.usoLLM = true;
                const respuesta = await openai.transcribirAudio(archivo.buffer, archivo.mimeType, opciones);
                mensaje.transcripcionAudio = respuesta.resultado;
                respuestas.push(respuesta);
            }
        }
        mensaje.estadoProcesamiento = 'completado';
        mensaje.errorProcesamiento = undefined;
    } catch (error) {
        mensaje.estadoProcesamiento = 'fallido';
        mensaje.errorProcesamiento = error.message;
        throw error;
    } finally {
        respuestaOpenAi = [mensaje.transcripcionImagen, mensaje.transcripcionAudio].filter(Boolean).join('\n') || null;
        mensaje.contenido = [contenido, mensaje.transcripcionImagen, mensaje.transcripcionAudio].filter(Boolean).join('\n')
            || (imagen ? '[Imagen]' : audio ? '[Audio]' : '');
        const tokens = respuestas.length ? Object.fromEntries(['entrada', 'salida', 'total'].map(campo =>
            [campo, respuestas.reduce((total, respuesta) => total + (respuesta.tokensGastados?.[campo] || 0), 0)])) : null;
        if (tokens) mensaje.tokens = Object.fromEntries(['entrada', 'salida', 'total'].map(campo =>
            [campo, (mensaje.tokens?.[campo] || 0) + tokens[campo]]));
        await mensaje.save();
        await actualizarConversacion(conversacion, mensaje, tokens);
        console.log({ mensaje: mensaje.contenido, respuestaOpenAi });
    }
    return { conversacion, mensaje, respuestaOpenAi };
}
/* async function recibirMensajeVendedor(conversacionId, contenido) {
    const conversacion = await Conversacion.findById(conversacionId);
    if (!conversacion?.telefono) throw new Error('La conversación no tiene teléfono de contacto.');
    const ultimoMensaje = conversacion.ultimoMensaje;
    const emisor = ultimoMensaje?.deClienteParaSistema ? ultimoMensaje.receptor : ultimoMensaje?.emisor;
    const whatsapp = require('./whatsapp');
    const crudo = await whatsapp.enviarMensaje({ to: conversacion.telefono, text: contenido });
    const mensaje = await Mensaje.create({
        conversacionId, contenido, emisor, receptor: conversacion.telefono,
        deClienteParaSistema: false, deSistemaParaCliente: true,
        usoLLM: false, fechaEmitida: new Date(), crudo,
    });
    conversacion.deClienteParaSistema = false;
    conversacion.ultimoMensaje = mensaje.toObject();
    await conversacion.save();
    await sockets.notificarCambios(conversacion, mensaje);
    return mensaje;
} */

module.exports = {
    recibirMensajeWhatsapp,
    /*
    recibirMensajeVendedor,
    */
};
