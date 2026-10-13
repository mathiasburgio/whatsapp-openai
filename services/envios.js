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

module.exports = { serializar, verificarLimiteMensual, bonificadoReferral };
