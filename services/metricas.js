const Uso = require('../models/uso');
const Mensaje = require('../models/mensaje');

async function obtenerMetricasMensuales(ahora = new Date()) {
    // El período coincide con el mes UTC que usan los límites de OpenAI.
    const inicio = new Date(0);
    inicio.setUTCFullYear(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1);
    const fin = new Date(0);
    fin.setUTCFullYear(ahora.getUTCFullYear(), ahora.getUTCMonth() + 1, 1);
    const [usos, respuestas] = await Promise.all([
        Uso.aggregate([
            { $match: { servicio: 'openai', createdAt: { $gte: inicio, $lt: fin }, estado: { $ne: 'rechazado' } } },
            { $group: {
                _id: null,
                llamadasWebSearch: { $sum: { $cond: ['$esBusquedaWeb', 1, 0] } },
                llamadasProcesarTexto: { $sum: { $cond: [{ $and: ['$esTexto', { $ne: ['$esBusquedaWeb', true] }, { $ne: ['$esDecision', true] }] }, 1, 0] } },
                segundosProcesados: { $sum: { $cond: [{ $and: ['$esAudio', { $eq: ['$estado', 'completado'] }] }, { $ifNull: ['$segundos', 0] }, 0] } },
                imagenesProcesadas: { $sum: { $cond: [{ $and: ['$esImagen', { $eq: ['$estado', 'completado'] }] }, 1, 0] } },
                tokensEntrada: { $sum: { $ifNull: ['$tokensEntrada', 0] } },
                tokensSalida: { $sum: { $ifNull: ['$tokensSalida', 0] } },
                tokensProcesados: { $sum: { $ifNull: ['$tokensTotal', { $add: [{ $ifNull: ['$tokensEntrada', 0] }, { $ifNull: ['$tokensSalida', 0] }] }] } },
            } },
            { $project: { _id: 0 } },
        ]),
        Mensaje.aggregate([
            { $match: { deSistemaParaCliente: true, whatsappId: { $type: 'string' }, fechaEmitida: { $gte: inicio, $lt: fin } } },
            { $group: { _id: null,
                respuestasAutomaticas: { $sum: { $cond: [{ $eq: ['$respuestaAutomatica', true] }, 1, 0] } },
                respuestasWhatsappTotales: { $sum: 1 },
                respuestasWhatsappConGracia: { $sum: { $cond: [{ $eq: ['$bonificadoReferral', true] }, 1, 0] } },
                respuestasWhatsappSinGracia: { $sum: { $cond: [{ $eq: ['$bonificadoReferral', true] }, 0, 1] } },
            } },
            { $project: { _id: 0 } },
        ]),
    ]);
    return {
        periodo: { inicio: inicio.toISOString(), fin: fin.toISOString(), zonaHoraria: 'UTC' },
        llamadasWebSearch: 0, llamadasProcesarTexto: 0, segundosProcesados: 0, imagenesProcesadas: 0,
        tokensEntrada: 0, tokensSalida: 0, tokensProcesados: 0,
        respuestasAutomaticas: 0, respuestasWhatsappTotales: 0, respuestasWhatsappConGracia: 0, respuestasWhatsappSinGracia: 0,
        ...usos[0], ...respuestas[0],
    };
}

module.exports = { obtenerMetricasMensuales };
