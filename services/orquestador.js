const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');
const sockets = require('./sockets');
const openai = require('./openai');
const archivos = require('./archivos');
const prompts = require('./prompts');
const promociones = require('./promociones');
const bot = require('./bot');
const envios = require('./envios');
const mongoose = require('mongoose');
const pendientesPorTelefono = new Map();
const enviosVendedor = new Map();

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
    await conversacion.save();
    if (tokens) await Conversacion.updateOne({ _id: conversacion._id }, { $inc: Object.fromEntries(
        ['entrada', 'salida', 'total'].map(campo => ['tokens.' + campo, tokens[campo] || 0])) });
    // Compara en la base: un archivo antiguo que termina de procesarse no pisa una respuesta del vendedor.
    await Conversacion.findOneAndUpdate({ _id: conversacion._id, $or: [
        { 'ultimoMensaje.fechaEmitida': { $exists: false } }, { 'ultimoMensaje.fechaEmitida': { $lte: mensaje.fechaEmitida } },
    ] }, { $set: { deClienteParaSistema: !!mensaje.deClienteParaSistema, ultimoMensaje: mensaje.toObject() } });
    const actualizada = await Conversacion.findById(conversacion._id);
    await sockets.notificarCambios(actualizada || conversacion, mensaje);
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
                contenidoOriginal: contenido, mediaPhoneNumberId: datos.phoneNumberId,
                contenido: contenido || (imagen ? '[Imagen]' : audio ? '[Audio]' : ''), deClienteParaSistema: true, deSistemaParaCliente: false,
                esImagen: !!imagen, esAudio: !!audio, usoLLM: false, estadoProcesamiento: 'pendiente',
                estadoBot: conversacion.botActivo ? 'pendiente' : 'omitido',
                revisionBot: conversacion.revisionBot || 0,
                fechaEmitida, crudo: datos.crudo });
        } catch (error) {
            if (error.code === 11000 && datos.whatsappId) return { mensaje: await Mensaje.findOne({ whatsappId: datos.whatsappId }), duplicado: true };
            throw error;
        }
    }
    try { await promociones.registrar(conversacion, mensaje); }
    catch (error) { console.error('No se pudo registrar el origen de la conversación:', error.message); }
    await actualizarConversacion(conversacion, mensaje);
    let respuestaOpenAi = null;
    const respuestas = [];
    try {
        if (imagen || audio) {
            const configuracion = await prompts.cargar();
            const opciones = { conversacionId: conversacion._id };
            if (imagen && !mensaje.transcripcionImagen) {
                const archivo = await archivos.obtenerMedia(mensaje, 'imagen', imagen, datos.phoneNumberId);
                if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(archivo.mimeType)) throw new Error('La imagen de WhatsApp tiene un formato no compatible.');
                const imagenUrl = `data:${archivo.mimeType};base64,${archivo.buffer.toString('base64')}`;
                mensaje.usoLLM = true;
                const respuesta = await openai.procesarImagen(imagenUrl, contenido || 'Describí qué hay en esta imagen.',
                    { ...opciones, instrucciones: configuracion.imagen });
                mensaje.transcripcionImagen = respuesta.resultado;
                respuestas.push(respuesta);
            }
            if (audio && !mensaje.transcripcionAudio) {
                const archivo = await archivos.obtenerMedia(mensaje, 'audio', audio, datos.phoneNumberId);
                mensaje.usoLLM = true;
                const respuesta = await openai.transcribirAudio(archivo.buffer, archivo.mimeType, { ...opciones, prompt: configuracion.audio });
                mensaje.transcripcionAudio = respuesta.resultado;
                respuestas.push(respuesta);
            }
        }
        mensaje.estadoProcesamiento = 'completado';
        mensaje.errorProcesamiento = undefined;
    } catch (error) {
        mensaje.estadoProcesamiento = 'fallido';
        mensaje.errorProcesamiento = error.message;
        // Si el archivo sigue siendo la consulta actual, requiere atención humana.
        await Conversacion.findOneAndUpdate({ _id: conversacion._id, 'ultimoMensaje._id': mensaje._id }, {
            $set: { botActivo: false, requiereAtencion: true, motivoDerivacion: 'No se pudo procesar el mensaje: ' + error.message.slice(0, 900) },
            $inc: { revisionBot: 1 },
        });
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
    try { await bot.responder(mensaje); }
    catch (error) { console.error('No se pudo guardar el estado del bot:', error.message); }
    return { conversacion, mensaje, respuestaOpenAi };
}
function recibirMensajeVendedor(conversacionId, contenido, datos = {}) {
    if (!mongoose.isObjectIdOrHexString(conversacionId) || typeof contenido !== 'string' || !contenido.trim() || contenido.trim().length > 4096
        || typeof datos.solicitudId !== 'string' || !/^[a-f0-9-]{36}$/i.test(datos.solicitudId)) return Promise.reject(new Error('Conversación, mensaje o identificador de envío inválidos.'));
    const clave = datos.solicitudId;
    const pendiente = enviosVendedor.get(clave);
    if (pendiente) {
        if (pendiente.conversacionId !== String(conversacionId) || pendiente.contenido !== contenido.trim()) return Promise.reject(new Error('El identificador de envío ya está en uso.'));
        return pendiente.promesa;
    }
    const promesa = enviarMensajeVendedor(conversacionId, contenido.trim(), datos);
    enviosVendedor.set(clave, { conversacionId: String(conversacionId), contenido: contenido.trim(), promesa });
    const limpiar = () => enviosVendedor.delete(clave);
    promesa.then(limpiar, limpiar);
    return promesa;
}
async function enviarMensajeVendedor(conversacionId, contenido, datos) {
    let mensaje = await Mensaje.findOne({ solicitudEnvioId: datos.solicitudId });
    if (mensaje) {
        if (String(mensaje.conversacionId) !== String(conversacionId) || mensaje.contenido !== contenido) throw new Error('El identificador de envío ya está en uso.');
        return mensaje;
    }
    // Pausa de inmediato, sin esperar las llamadas a IA que puedan estar en curso.
    const conversacion = await Conversacion.findOneAndUpdate({ _id: conversacionId }, {
        $set: { botActivo: false },
        $inc: { revisionBot: 1 },
    }, { returnDocument: 'after' });
    if (!conversacion?.telefono) throw new Error('La conversación no tiene teléfono de contacto.');
    const recibido = await Mensaje.findOne({ conversacionId, deClienteParaSistema: true }).sort({ createdAt: -1, _id: -1 });
    try {
        mensaje = await Mensaje.create({ conversacionId, contenido, emisor: recibido?.receptor,
            receptor: conversacion.telefono, mediaPhoneNumberId: recibido?.mediaPhoneNumberId,
            solicitudEnvioId: datos.solicitudId, vendedorId: datos.usuarioId,
            deClienteParaSistema: false, deSistemaParaCliente: true, respuestaAutomatica: false,
            usoLLM: false, estadoEnvio: 'enviando', fechaEmitida: new Date() });
    } catch (error) {
        if (error.code === 11000) return Mensaje.findOne({ solicitudEnvioId: datos.solicitudId });
        throw error;
    }
    await sockets.notificarCambios(conversacion, mensaje);
    await envios.serializar(async () => {
        let aceptado = false;
        try {
            const crudo = await require('./whatsapp').enviarMensaje({ to: conversacion.telefono, text: contenido,
                phoneNumberId: recibido?.mediaPhoneNumberId });
            const whatsappId = crudo?.messages?.[0]?.id;
            if (typeof whatsappId !== 'string' || !whatsappId) throw new Error('WhatsApp no confirmó el envío.');
            aceptado = true;
            mensaje.whatsappId = whatsappId;
            mensaje.crudo = crudo;
            mensaje.estadoEnvio = 'enviado';
            mensaje.estadoProcesamiento = 'completado';
            // La fecha de emisión corresponde al envío efectivo, no al momento de encolarlo.
            mensaje.fechaEmitida = new Date();
            await mensaje.save();
            await Conversacion.findOneAndUpdate({ _id: conversacionId }, { $set: {
                deClienteParaSistema: false, ultimoMensaje: mensaje.toObject(), requiereAtencion: false, motivoDerivacion: '',
            } });
        } catch (error) {
            mensaje.estadoEnvio = aceptado ? 'enviado' : error.envioNoIniciado || (error.status >= 400 && error.status < 500 && error.status !== 408) ? 'fallido' : 'envio_incierto';
            mensaje.errorEnvio = error.message.slice(0, 1000);
            await mensaje.save();
            if (!aceptado) await Conversacion.updateOne({ _id: conversacionId }, { $set: {
                requiereAtencion: true, motivoDerivacion: mensaje.estadoEnvio === 'fallido' ? 'La respuesta del vendedor no se pudo enviar.' : 'Revisar una respuesta con envío sin confirmar.',
            } });
        }
    });
    await sockets.notificarCambios(await Conversacion.findById(conversacionId), mensaje);
    return mensaje;
}

module.exports = {
    recibirMensajeWhatsapp,
    recibirMensajeVendedor,
};
