const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');
const sockets = require('./sockets');
const openai = require('./openai');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const prompts = require('./prompts');
const bot = require('./bot');
const envios = require('./envios');
const mongoose = require('mongoose');
const pendientesPorTelefono = new Map();

const formatosMedia = {
    imagen: { carpeta: 'imagenes', limite: 5_000_000, extensiones: {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    } },
    audio: { carpeta: 'audio', limite: 15_000_000, extensiones: {
        'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a',
        'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/wav': 'wav',
        'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/flac': 'flac',
    } },
};

async function descargarMedia(descriptor, tipo, mensaje, phoneNumberId) {
    const configuracion = formatosMedia[tipo];
    if (!configuracion || !descriptor?.id) throw new Error('El mensaje no tiene un archivo válido.');
    const archivo = await require('./whatsapp').obtenerMediaDesdeWhatsapp(descriptor.id,
        { phoneNumberId, maxBytes: configuracion.limite });
    const mimeType = archivo.mimeType.split(';')[0].trim().toLowerCase();
    const extension = configuracion.extensiones[mimeType];
    if (!extension) throw new Error('El archivo de WhatsApp tiene un formato no compatible.');
    const carpeta = path.join(__dirname, '..', 'uploads', configuracion.carpeta);
    const nombre = `${randomUUID()}.${extension}`;
    await fs.mkdir(carpeta, { recursive: true });
    await fs.writeFile(path.join(carpeta, nombre), archivo.buffer, { flag: 'wx' });
    mensaje[`${tipo}Archivo`] = nombre;
    await mensaje.save();
    return { buffer: archivo.buffer, mimeType };
}

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
    if (existente) return { mensaje: existente, duplicado: true };
    let conversacion = existente ? await Conversacion.findById(existente.conversacionId)
        : await Conversacion.findOne({ telefono }).sort({ updatedAt: -1 });
    if (!conversacion) conversacion = await Conversacion.create({ telefono, nombre: datos.nombre || telefono, deClienteParaSistema: true });
    else if (datos.nombre) conversacion.nombre = datos.nombre;
    const fechaEmitida = datos.fechaEmitida instanceof Date && Number.isFinite(datos.fechaEmitida.getTime()) ? datos.fechaEmitida : new Date();
    const referral = datos.crudo?.referral?.source_type === 'ad' ? datos.crudo.referral : undefined;
    let mensaje = existente;
    if (!mensaje) {
        try {
            mensaje = await Mensaje.create({ conversacionId: conversacion._id, whatsappId: datos.whatsappId,
                emisor: telefono, receptor: datos.receptor,
                contenidoOriginal: contenido, mediaPhoneNumberId: datos.phoneNumberId,
                contenido: contenido || (imagen ? '[Imagen]' : audio ? '[Audio]' : ''), deClienteParaSistema: true, deSistemaParaCliente: false,
                esImagen: !!imagen, esAudio: !!audio, usoLLM: false,
                estadoBot: conversacion.botActivo ? 'pendiente' : 'omitido',
                fechaEmitida, referral, crudo: datos.crudo });
        } catch (error) {
            if (error.code === 11000 && datos.whatsappId) return { mensaje: await Mensaje.findOne({ whatsappId: datos.whatsappId }), duplicado: true };
            throw error;
        }
    }
    if (mensaje.referral)  await Conversacion.updateOne({ _id: conversacion._id }, { $max: { referralFecha: fechaEmitida } });
    await actualizarConversacion(conversacion, mensaje);
    let respuestaOpenAi = null;
    let falloProcesamiento = false;
    const respuestas = [];
    try {
        if (imagen || audio) {
            const archivoImagen = imagen && !mensaje.transcripcionImagen
                ? await descargarMedia(imagen, 'imagen', mensaje, datos.phoneNumberId) : null;
            const archivoAudio = audio && !mensaje.transcripcionAudio
                ? await descargarMedia(audio, 'audio', mensaje, datos.phoneNumberId) : null;
            const configuracion = await prompts.cargar();
            const opciones = { conversacionId: conversacion._id, mensajeId: mensaje._id };
            if (archivoImagen) {
                const imagenUrl = `data:${archivoImagen.mimeType};base64,${archivoImagen.buffer.toString('base64')}`;
                mensaje.usoLLM = true;
                const respuesta = await openai.procesarImagen(imagenUrl, contenido || 'Describí qué hay en esta imagen.',
                    { ...opciones, instrucciones: configuracion.imagen });
                mensaje.transcripcionImagen = respuesta.resultado;
                respuestas.push(respuesta);
            }
            if (archivoAudio) {
                mensaje.usoLLM = true;
                const respuesta = await openai.transcribirAudio(archivoAudio.buffer, archivoAudio.mimeType, { ...opciones, prompt: configuracion.audio });
                mensaje.transcripcionAudio = respuesta.resultado;
                respuestas.push(respuesta);
            }
        }
    } catch (error) {
        falloProcesamiento = true;
        mensaje.estadoBot = 'omitido';
        console.error('No se pudo procesar el mensaje de WhatsApp:', error);
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
    if (falloProcesamiento) return { conversacion, mensaje, respuestaOpenAi };
    try { bot.encolar(mensaje); }
    catch (error) { console.error('No se pudo guardar el estado del bot:', error.message); }
    return { conversacion, mensaje, respuestaOpenAi };
}
function responderMensajePorApiWhataspp(conversacionId, contenido, datos = {}) {
    if (!mongoose.isObjectIdOrHexString(conversacionId) || typeof contenido !== 'string' || !contenido.trim() || contenido.trim().length > 4096) {
        return Promise.reject(new Error('Conversación o mensaje inválido.'));
    }
    return enviarMensajeVendedor(conversacionId, contenido.trim(), datos);
}
async function enviarMensajeVendedor(conversacionId, contenido, datos) {
    // Pausa de inmediato, sin esperar las llamadas a IA que puedan estar en curso.
    const conversacion = await Conversacion.findOneAndUpdate({ _id: conversacionId }, {
        $set: { botActivo: false },
    }, { returnDocument: 'after' });
    if (!conversacion?.telefono) throw new Error('La conversación no tiene teléfono de contacto.');
    await bot.cancelarEspera(conversacionId);
    const recibido = await Mensaje.findOne({ conversacionId, deClienteParaSistema: true }).sort({ createdAt: -1, _id: -1 });
    let mensaje;
    try {
        await envios.serializar(async () => {
            await envios.verificarLimiteMensual();
            const crudo = await require('./whatsapp').enviarMensaje({ to: conversacion.telefono, text: contenido,
                phoneNumberId: recibido?.mediaPhoneNumberId });
            const whatsappId = crudo?.messages?.[0]?.id;
            if (typeof whatsappId !== 'string' || !whatsappId) throw new Error('WhatsApp no confirmó el envío.');
            mensaje = await Mensaje.create({ conversacionId, contenido, emisor: recibido?.receptor,
                receptor: conversacion.telefono, mediaPhoneNumberId: recibido?.mediaPhoneNumberId,
                vendedorId: datos.usuarioId, deClienteParaSistema: false, deSistemaParaCliente: true,
                respuestaAutomatica: false, usoLLM: false, whatsappId, crudo, fechaEmitida: new Date() });
            await Conversacion.findOneAndUpdate({ _id: conversacionId }, { $set: {
                deClienteParaSistema: false, ultimoMensaje: mensaje.toObject(), requiereAtencion: false, motivoDerivacion: '',
            } });
        });
    } catch (error) {
        console.error('No se pudo enviar el mensaje del vendedor:', error);
        if (!mensaje) await Conversacion.updateOne({ _id: conversacionId }, { $set: {
            requiereAtencion: true, motivoDerivacion: 'No se pudo confirmar el envío del vendedor.',
        } });
        throw error;
    }
    await sockets.notificarCambios(await Conversacion.findById(conversacionId), mensaje);
    return mensaje;
}

module.exports = {
    recibirMensajeWhatsapp,
    responderMensajePorApiWhataspp,
};
