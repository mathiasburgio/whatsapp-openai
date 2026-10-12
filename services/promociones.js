const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');
const prompts = require('./prompts');

function normalizar(texto) {
    return String(texto || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function detectar(mensaje, reglas) {
    const texto = mensaje.contenidoOriginal ?? mensaje.crudo?.text?.body ?? mensaje.crudo?.image?.caption ?? mensaje.contenido ?? '';
    const coincidencias = reglas.flatMap(regla => regla.palabrasClave.filter(frase =>
        (' ' + normalizar(texto) + ' ').includes(' ' + normalizar(frase) + ' ')).map(frase => ({ regla, frase })));
    coincidencias.sort((a, b) => normalizar(b.frase).length - normalizar(a.frase).length);
    const coincidencia = coincidencias[0];
    const referenciaMeta = mensaje.crudo?.referral && typeof mensaje.crudo.referral === 'object' ? mensaje.crudo.referral : null;
    if (!coincidencia && !referenciaMeta) return null;
    return {
        fuente: referenciaMeta ? 'meta' : 'palabra_clave',
        promocionId: coincidencia?.regla.id || null,
        nombre: coincidencia?.regla.nombre || (referenciaMeta?.source_type === 'ad' ? 'Anuncio de Meta' : 'Referencia de Meta'),
        palabraClave: coincidencia?.frase || null,
        marca: coincidencia?.regla.marca || null,
        modelo: coincidencia?.regla.modelo || null,
        mensajeInicial: texto.slice(0, 1000),
        fecha: mensaje.fechaEmitida || mensaje.createdAt,
        referenciaMeta: referenciaMeta || undefined,
    };
}
async function registrar(conversacion, mensaje) {
    if (conversacion.origenInicializado) return;
    const primero = await Mensaje.findOne({ conversacionId: conversacion._id, deClienteParaSistema: true }).sort({ createdAt: 1, _id: 1 });
    const reglas = prompts.validarPromociones((await prompts.leer('promociones')).contenido);
    const origen = detectar(primero || mensaje, reglas);
    const actualizada = await Conversacion.findOneAndUpdate({ _id: conversacion._id, origenInicializado: { $ne: true } },
        { $set: { origenInicializado: true, ...(origen && { origenPromocion: origen }) } }, { returnDocument: 'after' });
    if (actualizada) {
        conversacion.origenInicializado = actualizada.origenInicializado;
        conversacion.origenPromocion = actualizada.origenPromocion;
    }
}
module.exports = { detectar, registrar };
