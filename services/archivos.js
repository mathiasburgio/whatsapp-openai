const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const Mensaje = require('../models/mensaje');

const raiz = path.resolve(__dirname, '../uploads');
const tipos = {
    imagen: { carpeta: 'imagenes', limite: 5000000, formatos: {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    } },
    audio: { carpeta: 'audio', limite: 15000000, formatos: {
        'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a',
        'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/wav': 'wav',
        'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/flac': 'flac',
    } },
};
const pendientes = new Map();

function rutaArchivo(mensaje, tipo) {
    const nombre = mensaje[`${tipo}Archivo`];
    // Solo se admiten nombres generados por el servidor, sin rutas suministradas por el cliente.
    if (!nombre || !/^[a-f0-9-]+\.[a-z0-9]+$/i.test(nombre)) return null;
    if (!tipos[tipo].formatos[mensaje[`${tipo}MimeType`]]) return null;
    return path.join(raiz, tipos[tipo].carpeta, nombre);
}

async function obtenerMedia(mensaje, tipo, descriptor = mensaje.crudo?.[tipo === 'imagen' ? 'image' : 'audio'], phoneNumberId = mensaje.mediaPhoneNumberId) {
    const clave = `${mensaje._id}:${tipo}`;
    if (pendientes.has(clave)) return pendientes.get(clave);
    const operacion = cargarMedia(mensaje, tipo, descriptor, phoneNumberId);
    pendientes.set(clave, operacion);
    try { return await operacion; }
    finally { pendientes.delete(clave); }
}

async function cargarMedia(mensaje, tipo, descriptor, phoneNumberId) {
    const configuracion = tipos[tipo];
    if (!configuracion) throw new Error('Tipo de archivo inválido.');
    let ruta = rutaArchivo(mensaje, tipo);
    if (ruta) {
        try { return { ruta, buffer: await fs.readFile(ruta), mimeType: mensaje[`${tipo}MimeType`] }; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!descriptor?.id) throw new Error('El mensaje no tiene un archivo disponible.');
    const archivo = await require('./whatsapp').descargarMedia(descriptor.id, { phoneNumberId, maxBytes: configuracion.limite });
    const mimeType = archivo.mimeType.split(';')[0].trim().toLowerCase();
    const extension = configuracion.formatos[mimeType];
    if (!extension) throw new Error('El archivo de WhatsApp tiene un formato no compatible.');
    const nombre = `${randomUUID()}.${extension}`;
    const carpeta = path.join(raiz, configuracion.carpeta);
    await fs.mkdir(carpeta, { recursive: true });
    ruta = path.join(carpeta, nombre);
    await fs.writeFile(ruta, archivo.buffer, { flag: 'wx' });
    mensaje[`${tipo}Archivo`] = nombre;
    mensaje[`${tipo}MimeType`] = mimeType;
    await mensaje.save();
    return { ruta, buffer: archivo.buffer, mimeType };
}

async function servirMedia(req, res, next) {
    const { mensajeId, tipo } = req.params;
    if (!mongoose.isObjectIdOrHexString(mensajeId) || !Object.hasOwn(tipos, tipo)) {
        return res.status(400).json({ error: 'Mensaje o tipo de archivo inválido.' });
    }
    try {
        const mensaje = await Mensaje.findById(mensajeId);
        if (!mensaje || !mensaje[tipo === 'imagen' ? 'esImagen' : 'esAudio']) {
            return res.status(404).json({ error: 'Archivo no encontrado.' });
        }
        const archivo = await obtenerMedia(mensaje, tipo);
        res.set({ 'Content-Type': archivo.mimeType, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
        res.sendFile(archivo.ruta, { cacheControl: false }, error => {
            if (error) next(error);
        });
    } catch (error) {
        console.error('No se pudo cargar el archivo del mensaje:', error.message);
        res.status(502).json({ error: 'No se pudo cargar el archivo de WhatsApp.' });
    }
}

module.exports = { obtenerMedia, servirMedia };
