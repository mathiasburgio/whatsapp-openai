const path = require('node:path');
const fs = require('node:fs/promises');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const mongo = require('../services/mongo');
const openai = require('../services/openai');
const carpetaPublic = path.join(__dirname, '..', 'public');
const ayuda = `Uso: npm run probar_openai -- <texto|audio|imagen|search|decisions> [entrada] [contexto]

texto:  texto entre comillas; por defecto pide un saludo corto.
audio:  URL o archivo; por defecto busca public/grabacion con su extensión.
imagen: URL o archivo; por defecto busca public/imagen-test con su extensión.
search: búsqueda entre comillas; por defecto busca información sobre motos.
decisions: prompt entre comillas y archivo JSON opcional con opciones y configuración.
           Por defecto usa scripts/decisions-example.json y una consulta sobre una moto.

Para usar el archivo o texto por defecto con contexto, usá --contexto.
Ejemplo: npm run probar_openai -- imagen --contexto "Describí qué hay en esta imagen."
Ejemplo: npm run probar_decisions -- "Quiero comprar una moto" scripts/decisions-example.json
Las pruebas consumen la API y se registran en la colección usos.`;

async function leerArchivo(origen, nombrePorDefecto) {
    if (!origen) {
        const archivos = await fs.readdir(carpetaPublic, { withFileTypes: true });
        const archivo = archivos.find(item => item.isFile() && (item.name === nombrePorDefecto || item.name.startsWith(`${nombrePorDefecto}.`)));
        if (!archivo) throw new Error(`No se encontró public/${nombrePorDefecto}. Agregá el archivo o pasá su ruta.`);
        origen = path.join(carpetaPublic, archivo.name);
    }
    const tipos = {
        '.webm': 'audio/webm', '.mp4': 'audio/mp4', '.m4a': 'audio/mp4',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.webp': 'image/webp', '.gif': 'image/gif',
    };
    if (/^https?:\/\//i.test(origen)) {
        const respuesta = await fetch(origen, { signal: AbortSignal.timeout(90000) });
        if (!respuesta.ok) throw new Error(`No se pudo descargar el archivo: HTTP ${respuesta.status}.`);
        const mime = respuesta.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        const tipo = mime?.startsWith('audio/') ? mime : tipos[path.extname(new URL(origen).pathname).toLowerCase()];
        return { buffer: Buffer.from(await respuesta.arrayBuffer()), tipo };
    }
    return { buffer: await fs.readFile(origen), tipo: tipos[path.extname(origen).toLowerCase()] };
}

async function main(argumentos = process.argv.slice(2)) {
    if (argumentos.includes('--help') || argumentos.includes('-h')) {
        console.log(ayuda);
        return;
    }
    let [tipo = 'texto', entrada, contexto] = argumentos;
    if (!['texto', 'audio', 'imagen', 'search', 'decisions'].includes(tipo) || argumentos.length > 3) throw new Error(ayuda);
    let decision;
    if (tipo === 'decisions') {
        if (entrada === '--contexto') throw new Error('Decisions recibe un prompt y un archivo JSON de configuración.');
        decision = JSON.parse(await fs.readFile(contexto || path.join(__dirname, 'decisions-example.json'), 'utf8'));
        if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('La configuración de Decisions debe ser un objeto JSON.');
    }
    if (entrada === '--contexto') {
        if (!contexto?.trim()) throw new Error('Indicá el contexto entre comillas después de --contexto.');
        entrada = undefined;
    }
    if (!process.env.OPENAI_API_KEY?.trim()) throw new Error('Falta definir OPENAI_API_KEY en .env.');
    const opciones = contexto ? { instrucciones: contexto } : {};
    let resultado;
    try {
        await mongo.connectDB();
        switch (tipo) {
            case 'texto':
                resultado = await openai.procesarTexto(entrada || 'Decime un saludo corto en español.', opciones);
                break;
            case 'audio': {
                const archivo = await leerArchivo(entrada, 'grabacion');
                if (!archivo.tipo?.startsWith('audio/')) throw new Error('Usá un audio webm, mp4, m4a, mp3, wav, ogg o flac.');
                resultado = await openai.transcribirAudio(archivo.buffer, archivo.tipo, { prompt: contexto || 'Transcribí este audio.' });
                break;
            }
            case 'imagen': {
                let imagen = entrada;
                if (!imagen || !/^https?:\/\//i.test(imagen)) {
                    const archivo = await leerArchivo(imagen, 'imagen-test');
                    if (!archivo.tipo?.startsWith('image/')) throw new Error('Usá una imagen jpg, png, webp o gif.');
                    imagen = `data:${archivo.tipo};base64,${archivo.buffer.toString('base64')}`;
                }
                resultado = await openai.procesarImagen(imagen, contexto || 'Describí qué hay en esta imagen.');
                break;
            }
            case 'search':
                resultado = await openai.procesarBusquedaWeb(entrada || '¿Qué motos de 110 cc se venden en Argentina?', contexto ? opciones : { instrucciones: 'Respondé brevemente e incluí las fuentes.' });
                break;
            case 'decisions': {
                const { opciones: alternativas, ...configuracion } = decision;
                resultado = await openai.procesarDecision(entrada || 'Quiero saber el precio y la financiación de una moto de 110 cc.', alternativas, configuracion);
                break;
            }
        }
        console.log(JSON.stringify(resultado, null, 2));
        return resultado;
    } finally {
        await mongo.disconnectDB();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { main };
