const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const carpeta = path.resolve(__dirname, '../prompts');
const definiciones = [
    { id: 'base', nombre: 'Reglas comunes', archivo: 'BASE.md', descripcion: 'Reglas compartidas por el orquestador, las respuestas y la memoria.' },
    { id: 'comercio', nombre: 'Datos del comercio', archivo: 'COMERCIO.md', descripcion: 'Dirección, horarios, formas de pago y condiciones confirmadas.' },
    { id: 'orquestador', nombre: 'Selección de acciones', archivo: 'ORQUESTADOR.md', descripcion: 'Cuándo responder, buscar una moto o derivar al vendedor.' },
    { id: 'respuesta', nombre: 'Respuesta al cliente', archivo: 'RESPUESTA.md', descripcion: 'Tono, estilo y contenido del mensaje que se envía por WhatsApp.' },
    { id: 'resumen', nombre: 'Resumen de conversación', archivo: 'RESUMEN.md', descripcion: 'Qué información conservar en la memoria.' },
    { id: 'imagen', nombre: 'Descripción de imágenes', archivo: 'IMAGEN.md', descripcion: 'Cómo describir las imágenes recibidas y expresar incertidumbre.' },
    { id: 'audio', nombre: 'Transcripción de audios', archivo: 'AUDIO.md', descripcion: 'Contexto para reconocer nombres de motos y transcribir el audio.' },
    { id: 'promociones', nombre: 'Palabras clave de promociones', archivo: 'PROMOCIONES.json', formato: 'json', descripcion: 'Reglas para identificar el origen por el primer mensaje; coincidencias sin distinguir mayúsculas ni tildes.' },
];
const escrituras = new Map();
const version = contenido => createHash('sha256').update(contenido).digest('hex');
function error(mensaje, status) { return Object.assign(new Error(mensaje), { status }); }
function definir(id) {
    const definicion = definiciones.find(item => item.id === id);
    if (!definicion) throw error('Prompt no encontrado.', 404);
    return definicion;
}
async function leer(id) {
    const definicion = definir(id);
    const contenido = await fs.readFile(path.join(carpeta, definicion.archivo), 'utf8');
    return { ...definicion, contenido, version: version(contenido) };
}
async function listar() { return Promise.all(definiciones.map(item => leer(item.id))); }
async function cargar() {
    const configuracion = Object.fromEntries((await listar()).map(item => [item.id, item.contenido]));
    validarPromociones(configuracion.promociones);
    return configuracion;
}
function validarPromociones(contenido) {
    let datos;
    try { datos = JSON.parse(contenido); } catch { throw error('La configuración de promociones debe ser un JSON válido.', 400); }
    if (!datos || Object.keys(datos).length !== 1 || !Array.isArray(datos.promociones) || datos.promociones.length > 100) throw error('Usá un objeto con un array promociones de hasta 100 reglas.', 400);
    const ids = new Set();
    for (const regla of datos.promociones) {
        if (!regla || Object.keys(regla).some(campo => !['id', 'nombre', 'palabrasClave'].includes(campo))
            || typeof regla.id !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(regla.id) || ids.has(regla.id)
            || typeof regla.nombre !== 'string' || !regla.nombre.trim() || regla.nombre.length > 160
            || !Array.isArray(regla.palabrasClave) || !regla.palabrasClave.length || regla.palabrasClave.length > 30
            || regla.palabrasClave.some(frase => typeof frase !== 'string' || !/[\p{L}\p{N}]/u.test(frase) || frase.length > 200)) {
            throw error('Promoción inválida: revisá id único, nombre y palabrasClave.', 400);
        }
        ids.add(regla.id);
    }
    return datos.promociones;
}
function instrucciones(configuracion, etapa) {
    const contenido = [configuracion.base, configuracion.comercio, configuracion[etapa]].join('\n\n');
    if (contenido.length > 30000) throw error('Las reglas comunes, datos del comercio y prompt de la etapa superan 30000 caracteres.', 400);
    return contenido;
}
async function guardar(id, contenido, versionAnterior) {
    definir(id);
    if (typeof contenido !== 'string' || !contenido.trim() || contenido.length > 16000 || contenido.includes('\0')) {
        throw error('El prompt debe tener entre 1 y 16000 caracteres, sin caracteres nulos.', 400);
    }
    if (typeof versionAnterior !== 'string' || !/^[a-f0-9]{64}$/.test(versionAnterior)) throw error('Falta la versión del prompt. Volvé a cargarlo.', 400);
    if (id === 'promociones') validarPromociones(contenido);
    // Serializa también cambios de distintos archivos que comparten el límite de instrucciones.
    const anterior = escrituras.get('todos') || Promise.resolve();
    const operacion = anterior.catch(() => {}).then(async () => {
        const actual = await leer(id);
        if (actual.version !== versionAnterior) throw error('El prompt cambió en otro editor. Volvé a cargarlo antes de guardar.', 409);
        const configuracion = await cargar();
        configuracion[id] = contenido;
        for (const etapa of ['orquestador', 'respuesta', 'resumen']) instrucciones(configuracion, etapa);
        const destino = path.join(carpeta, actual.archivo);
        const temporal = path.join(carpeta, '.' + randomUUID() + '.tmp');
        try {
            await fs.writeFile(temporal, contenido, { encoding: 'utf8', flag: 'wx' });
            await fs.rename(temporal, destino);
        } finally { await fs.rm(temporal, { force: true }); }
        return { ...actual, contenido, version: version(contenido) };
    });
    escrituras.set('todos', operacion);
    try { return await operacion; }
    finally { if (escrituras.get('todos') === operacion) escrituras.delete('todos'); }
}
module.exports = { leer, listar, cargar, instrucciones, guardar, validarPromociones };
