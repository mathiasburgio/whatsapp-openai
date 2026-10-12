const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');
const prompts = require('./prompts');

function normalizar(texto) {
    return String(texto || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function detectar(mensaje, reglas) {
    const texto = String(mensaje.contenidoOriginal ?? mensaje.crudo?.text?.body ?? mensaje.crudo?.image?.caption ?? mensaje.contenido ?? '').trim();
    const textoNormalizado = ' ' + normalizar(texto) + ' ';
    const coincide = reglas.some(regla => regla.palabrasClave.some(frase =>
        textoNormalizado.includes(' ' + normalizar(frase) + ' ')));
    const referenciaMeta = mensaje.crudo?.referral;
    if (coincide) return texto.slice(0, 1000);
    if (referenciaMeta && typeof referenciaMeta === 'object') {
        return String(referenciaMeta.headline || referenciaMeta.body || texto).trim().slice(0, 1000);
    }
    return '';
}
async function registrar(conversacion, mensaje) {
    if (conversacion.origenPromocion) return;
    const primero = await Mensaje.findOne({ conversacionId: conversacion._id, deClienteParaSistema: true }).sort({ createdAt: 1, _id: 1 });
    if (primero && String(primero._id) !== String(mensaje._id)) return;
    const reglas = prompts.validarPromociones((await prompts.leer('promociones')).contenido);
    const origen = detectar(primero || mensaje, reglas);
    if (!origen) return;
    const actualizada = await Conversacion.findOneAndUpdate({ _id: conversacion._id, origenPromocion: { $in: ['', null] } },
        { $set: { origenPromocion: origen } }, { returnDocument: 'after' });
    if (actualizada) conversacion.origenPromocion = actualizada.origenPromocion;
}
module.exports = { detectar, registrar };
