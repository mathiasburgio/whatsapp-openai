const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');
const openai = require('./openai');
const prompts = require('./prompts');
const vehiculos = require('./vehiculos');
const sockets = require('./sockets');
const envios = require('./envios');

const objeto = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const filtroSchema = objeto({ marca: { type: ['string', 'null'] }, modelo: { type: ['string', 'null'] },
    estado: { type: ['string', 'null'], enum: ['nuevo', 'usado', null] },
    precio_minimo: { type: ['number', 'null'] }, precio_maximo: { type: ['number', 'null'] } });
const esquemas = {
    orquestador: objeto({ accion: { type: 'string', enum: ['responder', 'buscar_vehiculo', 'notify_seller'] }, filtro: filtroSchema, motivo: { type: 'string' } }),
    respuesta: objeto({ mensaje: { type: 'string' } }),
    resumen: objeto({ resumen: { type: 'string' } }),
};

async function contexto(conversacion, mensaje) {
    const recientes = await Mensaje.find({ conversacionId: conversacion._id, $or: [
        { deSistemaParaCliente: { $ne: true } }, { estadoEnvio: { $exists: false } }, { estadoEnvio: 'enviado' },
    ] }).sort({ createdAt: -1, _id: -1 }).limit(12);
    const datos = {
        resumenAnterior: (conversacion.resumen || '').slice(0, 4000),
        origenPromocion: conversacion.origenPromocion ? {
            fuente: conversacion.origenPromocion.fuente, nombre: conversacion.origenPromocion.nombre,
            marca: conversacion.origenPromocion.marca, modelo: conversacion.origenPromocion.modelo,
        } : null,
        buscarVehiculoDisponible: vehiculos.disponible(),
        mensajeActualId: String(mensaje._id),
        mensajes: recientes.reverse().map(item => ({ id: String(item._id),
            autor: item.deSistemaParaCliente ? 'asistente' : 'cliente',
            texto: (item.contenidoOriginal ?? (item.esImagen || item.esAudio ? '' : item.contenido) ?? '').slice(0, 700),
            transcripcionAudio: item.transcripcionAudio?.slice(0, 700),
            inferenciaImagen: item.transcripcionImagen?.slice(0, 700),
        })),
    };
    while (JSON.stringify(datos).length > 18000 && datos.mensajes.length > 1) datos.mensajes.shift();
    return datos;
}
function validarDecision(decision) {
    if (!decision || !['responder', 'buscar_vehiculo', 'notify_seller'].includes(decision.accion)
        || typeof decision.motivo !== 'string' || decision.motivo.length > 1000 || !decision.filtro) throw new Error('Decisión del bot inválida.');
    for (const campo of ['marca', 'modelo']) {
        const valor = decision.filtro[campo];
        if (valor !== null && (typeof valor !== 'string' || !valor.trim() || valor.length > 80)) throw new Error('Filtro de moto inválido.');
    }
    if (![null, 'nuevo', 'usado'].includes(decision.filtro.estado)) throw new Error('Estado de moto inválido.');
    for (const campo of ['precio_minimo', 'precio_maximo']) {
        const valor = decision.filtro[campo];
        if (valor !== null && (!Number.isFinite(valor) || valor < 0)) throw new Error('Filtro de precio inválido.');
    }
    const { precio_minimo: min, precio_maximo: max } = decision.filtro;
    if (min !== null && max !== null && min > max) throw new Error('Rango de precios inválido.');
    if (decision.accion === 'buscar_vehiculo' && !Object.values(decision.filtro).some(valor => valor !== null)) throw new Error('La búsqueda necesita al menos un filtro.');
}
async function derivar(conversacionId, motivo) {
    return Conversacion.findOneAndUpdate({ _id: conversacionId }, {
        $set: { botActivo: false, requiereAtencion: true, motivoDerivacion: motivo.slice(0, 1000) },
        $inc: { revisionBot: 1 },
        $push: { notificacion: { lead: 'derivación', resumen: motivo.slice(0, 1000), creada: new Date(), aceptada: false } },
    }, { returnDocument: 'after' });
}
function habilitado(conversacion, mensaje) {
    return !!conversacion?.botActivo && (conversacion.revisionBot || 0) === (mensaje.revisionBot || 0);
}
async function verificarLimite() {
    const limite = Number(process.env.WHATSAPP_MONTHLY_RESPONSE_LIMIT || 2000);
    if (!Number.isSafeInteger(limite) || limite < 0) throw new Error('Límite mensual de respuestas inválido.');
    const ahora = new Date();
    const inicio = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1));
    const cantidad = await Mensaje.countDocuments({ respuestaAutomatica: true, deSistemaParaCliente: true,
        whatsappId: { $type: 'string' }, fechaEmitida: { $gte: inicio } });
    if (cantidad >= limite) throw new Error('Se alcanzó el límite mensual de respuestas automáticas.');
}
async function responder(mensaje) {
    if (!['pendiente', 'fallido'].includes(mensaje.estadoBot) || mensaje.estadoProcesamiento !== 'completado') return;
    // Reclamo atómico: los reintentos del webhook no vuelven a enviar una respuesta.
    const tomado = await Mensaje.findOneAndUpdate({ _id: mensaje._id, estadoBot: { $in: ['pendiente', 'fallido'] } },
        { $set: { estadoBot: 'procesando' }, $unset: { errorBot: '' } }, { returnDocument: 'after' });
    if (!tomado) return;
    mensaje.estadoBot = 'procesando';
    mensaje.errorBot = undefined;
    const tokens = { entrada: 0, salida: 0, total: 0 };
    let envioIniciado = false;
    let envioAceptado = false;
    let salida;
    try {
        let conversacion = await Conversacion.findById(mensaje.conversacionId);
        if (!habilitado(conversacion, mensaje)) { mensaje.estadoBot = 'omitido'; return; }
        const configuracion = await prompts.cargar();
        const datos = await contexto(conversacion, mensaje);
        async function consultar(etapa, entrada, maxTokensSalida) {
            let respuesta;
            try {
                respuesta = await openai.procesarTexto(JSON.stringify(entrada), {
                    instrucciones: prompts.instrucciones(configuracion, etapa),
                    esquema: { nombre: etapa, schema: esquemas[etapa] }, conversacionId: conversacion._id, maxTokensSalida,
                });
            } catch (error) {
                for (const campo of Object.keys(tokens)) tokens[campo] += error.tokensGastados?.[campo] || 0;
                throw error;
            }
            for (const campo of Object.keys(tokens)) tokens[campo] += respuesta.tokensGastados?.[campo] || 0;
            return respuesta.resultado;
        }
        const decision = await consultar('orquestador', datos, 600);
        validarDecision(decision);
        if (!habilitado(await Conversacion.findById(mensaje.conversacionId), mensaje)) { mensaje.estadoBot = 'omitido'; return; }
        let catalogo = { estado: 'no_consultado', vehiculos: [] };
        if (decision.accion === 'buscar_vehiculo') {
            try { catalogo = await vehiculos.buscar(decision.filtro); }
            catch { catalogo = { estado: 'error', vehiculos: [] }; }
            if (['sin_configurar', 'error'].includes(catalogo.estado)) {
                decision.accion = 'notify_seller';
                decision.motivo = 'Se necesita consultar precio o stock y el catálogo no está disponible.';
            }
        }
        mensaje.accionEjecutada = decision.accion;
        mensaje.parametroEjecutado = JSON.stringify(decision.filtro);
        mensaje.parametroRecibido = JSON.stringify(catalogo);
        const respuesta = await consultar('respuesta', { ...datos, decision, catalogo }, 1000);
        if (typeof respuesta?.mensaje !== 'string' || !respuesta.mensaje.trim() || respuesta.mensaje.length > 3500) throw new Error('Respuesta del bot vacía o demasiado larga.');
        await envios.serializar(async () => {
            // Revisa el interruptor justo antes del envío, incluso si cambió durante las llamadas a IA.
            conversacion = await Conversacion.findById(mensaje.conversacionId);
            if (!habilitado(conversacion, mensaje)) { mensaje.estadoBot = 'omitido'; return; }
            await verificarLimite();
            mensaje.estadoBot = 'enviando';
            await mensaje.save();
            envioIniciado = true;
            const crudo = await require('./whatsapp').enviarMensaje({ to: conversacion.telefono, text: respuesta.mensaje.trim(),
                phoneNumberId: mensaje.mediaPhoneNumberId, replyToMessageId: mensaje.whatsappId });
            const whatsappId = crudo?.messages?.[0]?.id;
            if (typeof whatsappId !== 'string' || !whatsappId) throw new Error('WhatsApp no confirmó el ID del mensaje enviado.');
            envioAceptado = true;
            salida = await Mensaje.create({ conversacionId: conversacion._id, whatsappId, respuestaA: mensaje._id,
                respuestaAutomatica: true, deSistemaParaCliente: true, deClienteParaSistema: false,
                emisor: mensaje.receptor, receptor: conversacion.telefono, contenido: respuesta.mensaje.trim(),
                mediaPhoneNumberId: mensaje.mediaPhoneNumberId,
                usoLLM: true, estadoProcesamiento: 'completado', fechaEmitida: new Date(), crudo });
            mensaje.estadoBot = decision.accion === 'notify_seller' ? 'derivado' : 'respondido';
            await Conversacion.updateOne({ _id: conversacion._id }, {
                $set: { deClienteParaSistema: false, ultimoMensaje: salida.toObject() }, $inc: { turnosDesdeResumen: 1 },
            });
            if (decision.accion === 'notify_seller') await derivar(conversacion._id, decision.motivo || 'El cliente requiere atención del vendedor.');
            await sockets.notificarCambios(await Conversacion.findById(conversacion._id), salida);
        });
        if (!salida) return;
        // Un fallo de resumen nunca convierte una respuesta aceptada en un envío pendiente.
        try {
            conversacion = await Conversacion.findById(conversacion._id);
            const cada = Number(process.env.BOT_RESUMEN_CADA_TURNOS || 5);
            if (Number.isSafeInteger(cada) && cada > 0 && conversacion.turnosDesdeResumen >= cada) {
                const memoria = await consultar('resumen', await contexto(conversacion, mensaje), 1300);
                if (typeof memoria?.resumen !== 'string' || !memoria.resumen.trim() || memoria.resumen.length > 4000) throw new Error('Resumen inválido.');
                await Conversacion.updateOne({ _id: conversacion._id }, { $set: { resumen: memoria.resumen, turnosDesdeResumen: 0 } });
            }
        } catch (error) { console.error('No se pudo actualizar el resumen:', error.message); }
    } catch (error) {
        mensaje.estadoBot = envioIniciado && !error.envioNoIniciado ? (envioAceptado ? 'respondido' : 'envio_incierto') : 'fallido';
        mensaje.errorBot = error.message;
        if (envioIniciado || habilitado(await Conversacion.findById(mensaje.conversacionId), mensaje)) await derivar(mensaje.conversacionId, error.message);
        else mensaje.estadoBot = 'omitido';
        console.error('No se pudo completar la respuesta automática:', error.message);
    } finally {
        for (const campo of Object.keys(tokens)) mensaje.set(`tokens.${campo}`, (mensaje.tokens?.[campo] || 0) + tokens[campo]);
        mensaje.usoLLM = mensaje.usoLLM || tokens.total > 0;
        await mensaje.save();
        await Conversacion.updateOne({ _id: mensaje.conversacionId }, { $inc: Object.fromEntries(
            Object.entries(tokens).map(([campo, valor]) => ['tokens.' + campo, valor])) });
        await sockets.notificarCambios(await Conversacion.findById(mensaje.conversacionId), mensaje);
    }
    return salida;
}
module.exports = { responder };
