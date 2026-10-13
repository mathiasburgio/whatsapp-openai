const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');
const openai = require('./openai');
const prompts = require('./prompts');
const vehiculos = require('./vehiculos');
const sockets = require('./sockets');
const envios = require('./envios');
const colaMensajes = require('./colaMensajes');
const accionesMensaje = require('./accionesMensaje');
const accionesExternas = require('./accionesExternas');

const objeto = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const filtroSchema = objeto({
    marca: { type: ['string', 'null'] },
    modelo: { type: ['string', 'null'] },
    precioMinimo: { type: ['number', 'null'], minimum: 0 },
    precioMaximo: { type: ['number', 'null'], minimum: 0 }
});
const esquemas = {
    orquestador: objeto({ accion: { type: 'string', enum: ['responder', 'buscar_vehiculo', 'notify_seller'] }, filtro: filtroSchema,
        motivo: { type: 'string' }, mensajesFueraDeTema: { type: 'array', items: { type: 'string' } },
        solicitudesExternas: { type: 'array', items: objeto({ mensajeId: { type: 'string' }, detalle: { type: 'string' } }) } }),
    respuesta: objeto({ mensaje: { type: 'string' } }),
    resumen: objeto({ resumen: { type: 'string' } }),
};

function pendientesExternos(conversacion) {
    return (conversacion.accionesExternasRequeridas || []).filter(item => !item.aceptada).slice(-3)
        .map(item => ({ id: String(item._id), detalle: item.detalle.slice(0, 250) }));
}
async function contexto(conversacion, mensaje, grupo = [mensaje]) {
    const recientes = await Mensaje.find({ conversacionId: conversacion._id, $or: [
        { deSistemaParaCliente: { $ne: true } }, { whatsappId: { $type: 'string' } },
    ] }).sort({ createdAt: -1, _id: -1 }).limit(12);
    const datos = {
        resumenAnterior: (conversacion.resumen || '').slice(0, 4000),
        buscarVehiculoDisponible: vehiculos.disponible(),
        accionesExternasPendientes: pendientesExternos(conversacion),
        mensajeActualId: String(mensaje._id),
        mensajeActual: grupo.map(item => [
            '[' + String(item._id) + ']',
            item.contenidoOriginal ?? (item.esImagen || item.esAudio ? '' : item.contenido),
            item.transcripcionAudio && 'Transcripción del audio: ' + item.transcripcionAudio,
            item.transcripcionImagen && 'Descripción de imagen: ' + item.transcripcionImagen,
        ].filter(Boolean).join('\n')).join('\n').slice(-12000),
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
function validarDecision(decision, grupo) {
    if (!decision || !['responder', 'buscar_vehiculo', 'notify_seller'].includes(decision.accion)
        || typeof decision.motivo !== 'string' || decision.motivo.length > 1000 || !decision.filtro) throw new Error('Decisión del bot inválida.');
    const ids = new Set(grupo.map(item => String(item._id)));
    if (!Array.isArray(decision.mensajesFueraDeTema)
        || decision.mensajesFueraDeTema.some(id => typeof id !== 'string' || !ids.has(id))
        || new Set(decision.mensajesFueraDeTema).size !== decision.mensajesFueraDeTema.length) throw new Error('Clasificación fuera de tema inválida.');
    if (!Array.isArray(decision.solicitudesExternas) || decision.solicitudesExternas.some(item => !item || !ids.has(item.mensajeId)
        || typeof item.detalle !== 'string' || !item.detalle.trim() || item.detalle.length > 1000)
        || new Set(decision.solicitudesExternas.map(item => item.mensajeId)).size !== decision.solicitudesExternas.length) throw new Error('Solicitud externa inválida.');
    if (Object.keys(decision.filtro).some(campo => !['marca', 'modelo', 'precioMinimo', 'precioMaximo'].includes(campo))) throw new Error('Filtro de moto inválido.');
    for (const campo of ['marca', 'modelo']) {
        const valor = decision.filtro[campo];
        if (valor !== null && (typeof valor !== 'string' || !valor.trim() || valor.length > 80)) throw new Error('Filtro de moto inválido.');
    }
    for (const campo of ['precioMinimo', 'precioMaximo']) {
        const valor = decision.filtro[campo];
        if (valor !== null && (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0)) throw new Error('Precio de búsqueda inválido.');
    }
    if (decision.filtro.precioMinimo !== null && decision.filtro.precioMaximo !== null
        && decision.filtro.precioMinimo > decision.filtro.precioMaximo) throw new Error('Rango de precios inválido.');
    if (decision.accion === 'buscar_vehiculo' && !Object.values(decision.filtro).some(valor => valor !== null)) throw new Error('La búsqueda necesita al menos un filtro.');
}
function habilitado(conversacion) {
    return !!conversacion?.botActivo;
}
async function registrarConsultasFueraDeTema(conversacionId, grupo, ids) {
    const ahora = new Date(Date.now());
    for (const mensaje of grupo.filter(item => ids.includes(String(item._id)))) {
        // El mismo mensaje no vuelve a sumar al reiniciar la espera o reintentar un turno.
        await Conversacion.updateOne({ _id: conversacionId, 'consultasFueraDeTema.mensajeId': { $ne: mensaje._id } },
            { $push: { consultasFueraDeTema: { fecha: mensaje.createdAt || ahora, mensajeId: mensaje._id } } }, { runValidators: true });
    }
    const conversacion = await Conversacion.findById(conversacionId);
    const desde = ahora.getTime() - 24 * 60 * 60 * 1000;
    const cantidad = (conversacion.consultasFueraDeTema || []).filter(item => item.fecha.getTime() > desde && item.fecha <= ahora).length;
    return { conversacion, cantidad };
}
async function encolar(mensaje) {
    if (mensaje.estadoBot !== 'pendiente') {
        await accionesMensaje.registrar(mensaje, 'esperar_mensajes', 'omitida', { motivo: 'El bot estaba inactivo al recibir el mensaje.' });
        return;
    }
    await accionesMensaje.registrar(mensaje, 'esperar_mensajes', 'iniciada', { segundos: colaMensajes.segundosEspera() });
    colaMensajes.agregar(mensaje, responder);
}
async function cancelarEspera(conversacionId, motivo = 'Se desactivó el bot.') {
    for (const mensaje of colaMensajes.cancelar(conversacionId)) {
        await Mensaje.updateOne({ _id: mensaje._id, estadoBot: 'pendiente' }, { $set: { estadoBot: 'omitido' } });
        if (mensaje.estadoBot === 'pendiente') mensaje.estadoBot = 'omitido';
        await accionesMensaje.registrar(mensaje, 'esperar_mensajes', 'omitida', { motivo });
        await sockets.notificarCambios(await Conversacion.findById(conversacionId), mensaje);
    }
}
async function responder(mensaje, grupo = [mensaje], control = {}) {
    if (!['pendiente', 'fallido'].includes(mensaje.estadoBot)) return;
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
    let accionEnCurso;
    let motivoOmision;
    function continuar(conversacion) {
        if (!habilitado(conversacion) || control.cancelada?.()) {
            mensaje.estadoBot = 'omitido'; motivoOmision = 'El bot se desactivó o se canceló la espera.'; return false;
        }
        if (control.vigente && !control.vigente()) {
            mensaje.estadoBot = 'pendiente'; motivoOmision = 'Llegaron más mensajes; se reinicia la espera para responder al bloque completo.'; return false;
        }
        return true;
    }
    try {
        if (control.desdeCola) await accionesMensaje.registrar(mensaje, 'esperar_mensajes', 'ok', {
            cantidad: grupo.length, mensajesIds: grupo.map(item => String(item._id)),
        });
        let conversacion = await Conversacion.findById(mensaje.conversacionId);
        if (!continuar(conversacion)) return;
        accionEnCurso = 'interpretar';
        await accionesMensaje.registrar(mensaje, 'interpretar', 'iniciada', { catalogoHabilitado: vehiculos.disponible() });
        const configuracion = await prompts.cargar();
        const datos = await contexto(conversacion, mensaje, grupo);
        if (!continuar(conversacion)) return;
        async function consultar(etapa, entrada, maxTokensSalida) {
            let respuesta;
            try {
                respuesta = await openai.procesarTexto(JSON.stringify(entrada), {
                    instrucciones: prompts.instrucciones(configuracion, etapa),
                    esquema: { nombre: etapa, schema: esquemas[etapa] }, conversacionId: conversacion._id,
                    mensajeId: mensaje._id, maxTokensSalida,
                });
            } catch (error) {
                for (const campo of Object.keys(tokens)) tokens[campo] += error.tokensGastados?.[campo] || 0;
                throw error;
            }
            for (const campo of Object.keys(tokens)) tokens[campo] += respuesta.tokensGastados?.[campo] || 0;
            return respuesta.resultado;
        }
        const decision = await consultar('orquestador', datos, 1000);
        validarDecision(decision, grupo);
        await accionesMensaje.registrar(mensaje, 'interpretar', 'ok', {
            accionElegida: decision.accion, motivo: decision.motivo, filtro: decision.filtro,
            catalogoHabilitado: datos.buscarVehiculoDisponible,
            mensajesFueraDeTema: decision.mensajesFueraDeTema,
            solicitudesExternas: decision.solicitudesExternas,
        });
        accionEnCurso = null;
        if (!continuar(await Conversacion.findById(mensaje.conversacionId))) return;
        if (decision.mensajesFueraDeTema.length) {
            accionEnCurso = 'registrar_fuera_de_tema';
            await accionesMensaje.registrar(mensaje, accionEnCurso, 'iniciada', { mensajesIds: decision.mensajesFueraDeTema });
            const registro = await registrarConsultasFueraDeTema(mensaje.conversacionId, grupo, decision.mensajesFueraDeTema);
            await accionesMensaje.registrar(mensaje, accionEnCurso, 'ok', { cantidad24Horas: registro.cantidad, mensajesIds: decision.mensajesFueraDeTema });
            await sockets.notificarCambios(registro.conversacion, mensaje);
            accionEnCurso = null;
            if (registro.cantidad >= 3) {
                const motivo = 'Se registraron ' + registro.cantidad + ' consultas fuera de tema en las últimas 24 horas. Requiere revisión del vendedor.';
                accionEnCurso = 'bloquear_bot';
                await accionesMensaje.registrar(mensaje, accionEnCurso, 'iniciada', { motivo });
                await accionesExternas.requerir(mensaje.conversacionId, motivo, mensaje._id);
                await Conversacion.updateOne({ _id: mensaje.conversacionId }, { $set: { botActivo: false } });
                await cancelarEspera(mensaje.conversacionId, motivo);
                mensaje.estadoBot = 'derivado';
                mensaje.accionEjecutada = 'notify_seller';
                mensaje.parametroEjecutado = JSON.stringify(decision.filtro);
                mensaje.parametroRecibido = JSON.stringify({ estado: 'no_consultado', vehiculos: [] });
                await accionesMensaje.registrar(mensaje, accionEnCurso, 'ok', { cantidad24Horas: registro.cantidad, motivo });
                accionEnCurso = null;
                motivoOmision = motivo;
                return;
            }
            if (decision.mensajesFueraDeTema.length === grupo.length) {
                decision.accion = 'responder';
                decision.filtro = { marca: null, modelo: null, precioMinimo: null, precioMaximo: null };
                decision.motivo = 'Consulta fuera de tema: orientar al cliente a las consultas del comercio.';
                decision.solicitudesExternas = [];
            }
        }
        let catalogo = { estado: 'no_consultado', vehiculos: [] };
        if (decision.accion === 'buscar_vehiculo') {
            accionEnCurso = 'buscar_vehiculo';
            if (datos.buscarVehiculoDisponible) await accionesMensaje.registrar(mensaje, 'buscar_vehiculo', 'iniciada', { filtro: decision.filtro });
            let errorCatalogo;
            try { catalogo = await vehiculos.buscar(decision.filtro); }
            catch (error) { catalogo = { estado: 'error', vehiculos: [] }; errorCatalogo = error.message; }
            await accionesMensaje.registrar(mensaje, 'buscar_vehiculo', catalogo.estado === 'sin_configurar' ? 'omitida' : catalogo.estado === 'error' ? 'error' : 'ok', {
                filtro: decision.filtro, estadoCatalogo: catalogo.estado, cantidad: catalogo.vehiculos.length,
                ...(catalogo.estado === 'sin_configurar' ? { motivo: 'El catálogo está deshabilitado.' } : {}),
                ...(errorCatalogo ? { error: errorCatalogo } : {}),
            });
            accionEnCurso = null;
            if (['sin_configurar', 'error'].includes(catalogo.estado)) {
                decision.accion = 'notify_seller';
                decision.motivo = 'No se pudo confirmar la consulta en el catálogo; requiere revisión del vendedor.';
                const solicitud = decision.solicitudesExternas.find(item => item.mensajeId === String(mensaje._id));
                if (solicitud) solicitud.detalle = (solicitud.detalle + ' ' + decision.motivo).slice(0, 1000);
                else decision.solicitudesExternas.push({ mensajeId: String(mensaje._id), detalle: decision.motivo });
            }
        } else await accionesMensaje.registrar(mensaje, 'buscar_vehiculo', 'omitida', {
            motivo: 'El orquestador eligió ' + decision.accion + ': ' + decision.motivo,
            accionElegida: decision.accion, catalogoHabilitado: datos.buscarVehiculoDisponible,
        });
        mensaje.accionEjecutada = decision.accion;
        mensaje.parametroEjecutado = JSON.stringify(decision.filtro);
        mensaje.parametroRecibido = JSON.stringify(catalogo);
        if (decision.accion === 'notify_seller' && !decision.solicitudesExternas.length) {
            decision.solicitudesExternas.push({ mensajeId: String(mensaje._id), detalle: decision.motivo });
        }
        if (decision.solicitudesExternas.length) {
            accionEnCurso = 'solicitar_intervencion';
            await accionesMensaje.registrar(mensaje, accionEnCurso, 'iniciada', { solicitudes: decision.solicitudesExternas });
            for (const solicitud of decision.solicitudesExternas) {
                conversacion = await accionesExternas.requerir(mensaje.conversacionId, solicitud.detalle, solicitud.mensajeId);
            }
            datos.accionesExternasPendientes = pendientesExternos(conversacion);
            await accionesMensaje.registrar(mensaje, accionEnCurso, 'ok', { solicitudes: decision.solicitudesExternas });
            await sockets.notificarCambios(conversacion, mensaje);
        }
        accionEnCurso = 'generar_respuesta';
        await accionesMensaje.registrar(mensaje, 'generar_respuesta', 'iniciada');
        const respuesta = await consultar('respuesta', { ...datos, decision, catalogo }, 1000);
        if (typeof respuesta?.mensaje !== 'string' || !respuesta.mensaje.trim() || respuesta.mensaje.length > 3500) throw new Error('Respuesta del bot vacía o demasiado larga.');
        await accionesMensaje.registrar(mensaje, 'generar_respuesta', 'ok');
        accionEnCurso = 'responder';
        await accionesMensaje.registrar(mensaje, 'responder', 'iniciada');
        await envios.serializar(async () => {
            // Revisa el interruptor justo antes del envío, incluso si cambió durante las llamadas a IA.
            conversacion = await Conversacion.findById(mensaje.conversacionId);
            if (!continuar(conversacion)) return;
            await envios.verificarLimiteMensual();
            if (!continuar(conversacion)) return;
            mensaje.estadoBot = 'enviando';
            await mensaje.save();
            if (!continuar(conversacion)) return;
            envioIniciado = true;
            const crudo = await require('./whatsapp').enviarMensaje({ to: conversacion.telefono, text: respuesta.mensaje.trim(),
                phoneNumberId: mensaje.mediaPhoneNumberId, replyToMessageId: mensaje.whatsappId });
            const whatsappId = crudo?.messages?.[0]?.id;
            if (typeof whatsappId !== 'string' || !whatsappId) throw new Error('WhatsApp no confirmó el ID del mensaje enviado.');
            envioAceptado = true;
            await accionesMensaje.registrar(mensaje, 'responder', 'ok', { whatsappId });
            accionEnCurso = 'guardar_respuesta';
            const fechaEmitida = new Date();
            const tiempoDesdeReferral = conversacion.referralFecha
                ? fechaEmitida.getTime() - conversacion.referralFecha.getTime()
                : NaN;
            const bonificadoReferral = tiempoDesdeReferral >= 0 && tiempoDesdeReferral < 72 * 60 * 60 * 1000;
            salida = await Mensaje.create({ conversacionId: conversacion._id, whatsappId, respuestaA: mensaje._id,
                respuestaAutomatica: true, deSistemaParaCliente: true, deClienteParaSistema: false,
                emisor: mensaje.receptor, receptor: conversacion.telefono, contenido: respuesta.mensaje.trim(),
                mediaPhoneNumberId: mensaje.mediaPhoneNumberId,
                usoLLM: true, fechaEmitida, bonificadoReferral, crudo });
            mensaje.estadoBot = 'respondido';
            await Conversacion.updateOne({ _id: conversacion._id }, {
                $set: { deClienteParaSistema: false, ultimoMensaje: salida.toObject() }, $inc: { turnosDesdeResumen: 1 },
            });
            await sockets.notificarCambios(await Conversacion.findById(conversacion._id), salida);
            accionEnCurso = null;
        });
        if (!salida) return;
        // Un fallo de resumen nunca convierte una respuesta aceptada en un envío pendiente.
        try {
            conversacion = await Conversacion.findById(conversacion._id);
            const cada = Number(process.env.BOT_RESUMEN_CADA_TURNOS || 5);
            if (Number.isSafeInteger(cada) && cada > 0 && conversacion.turnosDesdeResumen >= cada) {
                await accionesMensaje.registrar(mensaje, 'actualizar_resumen', 'iniciada');
                const memoria = await consultar('resumen', await contexto(conversacion, mensaje, grupo), 1300);
                if (typeof memoria?.resumen !== 'string' || !memoria.resumen.trim() || memoria.resumen.length > 4000) throw new Error('Resumen inválido.');
                await Conversacion.updateOne({ _id: conversacion._id }, { $set: { resumen: memoria.resumen, turnosDesdeResumen: 0 } });
                await accionesMensaje.registrar(mensaje, 'actualizar_resumen', 'ok');
            }
        } catch (error) {
            await accionesMensaje.registrar(mensaje, 'actualizar_resumen', 'error', { error: error.message });
            console.error('No se pudo actualizar el resumen:', error.message);
        }
    } catch (error) {
        mensaje.estadoBot = envioIniciado && !error.envioNoIniciado ? (envioAceptado ? 'respondido' : 'envio_incierto') : 'fallido';
        mensaje.errorBot = error.message;
        await accionesMensaje.registrar(mensaje, accionEnCurso || 'procesar_respuesta', 'error', {
            error: error.message, envioIniciado, envioAceptado,
        });
        if (envioIniciado || habilitado(await Conversacion.findById(mensaje.conversacionId))) {
            await accionesExternas.requerir(mensaje.conversacionId, error.message, mensaje._id);
        } else mensaje.estadoBot = 'omitido';
        console.error('No se pudo completar la respuesta automática:', error.message);
    } finally {
        if (motivoOmision) {
            if (accionEnCurso && accionEnCurso !== 'responder') await accionesMensaje.registrar(mensaje, accionEnCurso, 'omitida', { motivo: motivoOmision });
            await accionesMensaje.registrar(mensaje, 'responder', 'omitida', { motivo: motivoOmision });
        }
        for (const campo of Object.keys(tokens)) mensaje.set(`tokens.${campo}`, (mensaje.tokens?.[campo] || 0) + tokens[campo]);
        mensaje.usoLLM = mensaje.usoLLM || tokens.total > 0;
        await mensaje.save();
        await Conversacion.updateOne({ _id: mensaje.conversacionId }, { $inc: Object.fromEntries(
            Object.entries(tokens).map(([campo, valor]) => ['tokens.' + campo, valor])) });
        await sockets.notificarCambios(await Conversacion.findById(mensaje.conversacionId), mensaje);
        if (mensaje.estadoBot !== 'pendiente') {
            for (const anterior of grupo.filter(item => String(item._id) !== String(mensaje._id))) {
                anterior.estadoBot = mensaje.estadoBot === 'omitido' ? 'omitido' : 'agrupado';
                await anterior.save();
                await accionesMensaje.registrar(anterior, 'agrupar_mensajes', 'ok', {
                    mensajePrincipalId: String(mensaje._id), estadoPrincipal: mensaje.estadoBot,
                });
                await sockets.notificarCambios(await Conversacion.findById(mensaje.conversacionId), anterior);
            }
        }
    }
    return salida;
}
module.exports = { responder, encolar, cancelarEspera };
