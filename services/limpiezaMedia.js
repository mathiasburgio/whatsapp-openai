const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const cron = require('node-cron');

const VARIABLE_DIAS = 'MEDIA_CLEANUP_DAYS';
const MILISEGUNDOS_POR_DIA = 86_400_000;
const CARPETA_UPLOADS = path.join(__dirname, '..', 'uploads');
const ARCHIVO_ULTIMA_LIMPIEZA = path.join(CARPETA_UPLOADS, '.ultima-limpieza-media');
const CARPETAS_MEDIA = [
    { nombre: 'imagenes', extensiones: /\.(?:jpe?g|png|webp|gif)$/i },
    { nombre: 'audio', extensiones: /\.(?:ogg|mp3|m4a|aac|amr|wav|webm|flac)$/i },
];

async function verificarCarpetaSinEnlaces(ruta) {
    const estado = await fs.lstat(ruta);
    if (!estado.isDirectory()) throw new Error(`${ruta} no es un directorio directo.`);
}

async function leerUltimaLimpieza() {
    try {
        const fecha = Number(await fs.readFile(ARCHIVO_ULTIMA_LIMPIEZA, 'utf8'));
        if (!Number.isSafeInteger(fecha) || fecha <= 0) {
            throw new Error('La fecha guardada de la última limpieza no es válida.');
        }
        return fecha;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

// Guarda el turno del cron de forma atómica para conservar el intervalo entre reinicios.
async function guardarUltimaLimpieza(fecha) {
    const temporal = `${ARCHIVO_ULTIMA_LIMPIEZA}.${randomUUID()}.tmp`;
    await fs.writeFile(temporal, String(fecha), { flag: 'wx' });
    try {
        await fs.rename(temporal, ARCHIVO_ULTIMA_LIMPIEZA);
    } catch (error) {
        await fs.rm(temporal, { force: true });
        throw error;
    }
}

async function limpiarCarpetaMedia({ nombre, extensiones }, fechaLimite) {
    const ruta = path.join(CARPETA_UPLOADS, nombre);
    const resultado = { eliminados: 0, bytes: 0, errores: 0 };
    try {
        await verificarCarpetaSinEnlaces(ruta);
        const directorio = await fs.opendir(ruta);
        for await (const entrada of directorio) {
            if (!entrada.isFile() || !extensiones.test(entrada.name)) continue;
            const archivo = path.join(ruta, entrada.name);
            try {
                const estado = await fs.lstat(archivo);
                if (!estado.isFile() || estado.mtimeMs >= fechaLimite) continue;
                await fs.unlink(archivo);
                resultado.eliminados++;
                resultado.bytes += estado.size;
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                resultado.errores++;
                console.error(`[Limpieza de media] Error al borrar un archivo de ${nombre}:`, error.message);
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            resultado.errores++;
            console.error(`[Limpieza de media] Error al recorrer ${nombre}:`, error.message);
        }
    }
    return resultado;
}

async function ejecutarLimpiezaSiCorresponde(fechaProgramada, intervaloMs) {
    await verificarCarpetaSinEnlaces(CARPETA_UPLOADS);
    const ultimaLimpieza = await leerUltimaLimpieza();
    if (ultimaLimpieza !== null && fechaProgramada - ultimaLimpieza < intervaloMs) return;

    const fechaLimite = Date.now() - intervaloMs;
    let huboErrores = false;
    for (const carpeta of CARPETAS_MEDIA) {
        const { eliminados, bytes, errores } = await limpiarCarpetaMedia(carpeta, fechaLimite);
        if (errores) huboErrores = true;
        console.log(`[Limpieza de media] ${carpeta.nombre}: ${eliminados} archivos eliminados, ${bytes} bytes, ${errores} errores.`);
    }
    // Si falla una parte, el cron vuelve a intentarlo en el próximo turno.
    if (!huboErrores) await guardarUltimaLimpieza(fechaProgramada);
}

function programarLimpiezaMedia() {
    const valor = (process.env[VARIABLE_DIAS] || '').trim();
    if (!valor || valor === '0') return;
    const intervaloMs = Number(valor) * MILISEGUNDOS_POR_DIA;
    if (!/^[1-9]\d*$/.test(valor) || !Number.isSafeInteger(intervaloMs)) {
        console.error(`[Limpieza de media] ${VARIABLE_DIAS} debe ser un entero positivo o 0 para desactivar.`);
        return;
    }

    // Revisar a cada hora permite retomar una limpieza pendiente tras una caída o un reinicio.
    cron.schedule('0 * * * *', async function revisarLimpiezaProgramada({ date }) {
        try {
            await ejecutarLimpiezaSiCorresponde(date.getTime(), intervaloMs);
        } catch (error) {
            console.error('[Limpieza de media] Error en la tarea programada:', error.message);
        }
    }, { name: 'limpieza-media', timezone: 'UTC', noOverlap: true });
}

module.exports = { programarLimpiezaMedia };
