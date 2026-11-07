const Mensaje = require('../models/mensaje');

// Coordina el envío manual y el automático dentro de este proceso.
let pendiente = Promise.resolve();
function serializar(operacion) {
    const actual = pendiente.catch(() => {}).then(operacion);
    pendiente = actual;
    return actual;
}

function bonificadoReferral(conversacion, fechaEmitida) {
    const desde = conversacion?.referralFecha;
    const transcurrido = desde instanceof Date ? fechaEmitida.getTime() - desde.getTime() : NaN;
    return transcurrido >= 0 && transcurrido < 72 * 60 * 60 * 1000;
}

async function verificarLimiteMensual() {
    const limite = Number(process.env.WHATSAPP_MONTHLY_RESPONSE_LIMIT ?? 2000);
    if (!Number.isSafeInteger(limite) || limite < 0) throw new Error('Límite mensual de respuestas inválido.');
    const ahora = new Date();
    const inicio = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1));
    const fin = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() + 1, 1));
    const cantidad = await Mensaje.countDocuments({
        deSistemaParaCliente: true,
        whatsappId: { $type: 'string' },
        fechaEmitida: { $gte: inicio, $lt: fin },
    });
    if (cantidad >= limite) throw new Error('Se alcanzó el límite mensual de respuestas de WhatsApp.');
}

// Los mensajes de Test se guardan por el mismo flujo, sin contactar a Meta.
async function enviarPorCanal(conversacion, datos) {
    if (conversacion.canal === 'simulador') {
        const url = datos.imageUrl && URL.canParse(datos.imageUrl) ? new URL(datos.imageUrl) : null;
        if (typeof datos.text !== 'string' || !datos.text.trim() || datos.text.length > (datos.imageUrl ? 1024 : 4096)
            || (datos.imageUrl && (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password))) {
            throw Object.assign(new Error('La respuesta no cumple los límites de texto o imagen del canal.'), { envioNoIniciado: true });
        }
        return { simulado: true };
    }
    const whatsapp = require('./whatsapp');
    const enviar = datos.imageUrl ? whatsapp.enviarMensajeConImagen : whatsapp.enviarMensaje;
    const respuesta = await enviar(datos);
    if (typeof respuesta?.messages?.[0]?.id !== 'string' || !respuesta.messages[0].id) {
        throw new Error('WhatsApp no confirmó el ID del mensaje enviado.');
    }
    return respuesta;
}

module.exports = { serializar, verificarLimiteMensual, bonificadoReferral, enviarPorCanal };
