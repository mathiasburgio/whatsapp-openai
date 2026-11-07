/*
 * Atiende los mensajes pendientes: interpreta la consulta, busca motos por marca,
 * solicita intervención cuando corresponde y envía la respuesta por WhatsApp.
 * El contexto, los esquemas del LLM y el flujo quedan juntos en este archivo.
 */
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

// El esquema de salida del LLM define los tipos; no se vuelven a validar campo por campo.
function crearEsquemaObjeto(propiedades) {
    return {
        type: 'object',
        properties: propiedades,
        required: Object.keys(propiedades),
        additionalProperties: false,
    };
}

const esquemaPreferenciasVehiculo = crearEsquemaObjeto({
    marca: {
        type: ['string', 'null'],
        description: 'Único filtro enviado al catálogo. '
            + 'Inferí la marca del mensaje o del historial cuando sea clara. '
            + 'Para buscar_vehiculo necesitás una marca; si falta, elegí responder y pedila.',
    },
    modelo: {
        type: ['string', 'null'],
        description: 'Preferencia para seleccionar entre los resultados de la marca; no se envía al catálogo.',
    },
    precioMinimo: { type: ['number', 'null'], minimum: 0 },
    precioMaximo: { type: ['number', 'null'], minimum: 0 },
    vehiculoId: { type: ['string', 'null'], pattern: '^[a-fA-F0-9]{24}$' },
});

const esquemasPorEtapa = {
    orquestador: crearEsquemaObjeto({
        accion: { type: 'string', enum: ['responder', 'buscar_vehiculo', 'notify_seller'] },
        filtro: esquemaPreferenciasVehiculo,
        motivo: { type: 'string' },
        mensajesFueraDeTema: {
            type: 'array',
            items: { type: 'string' },
        },
        solicitudesExternas: {
            type: 'array',
            items: crearEsquemaObjeto({
                mensajeId: { type: 'string' },
                detalle: { type: 'string' },
            }),
        },
    }),
    respuesta: crearEsquemaObjeto({
        mensaje: {
            type: 'string',
            minLength: 1,
            maxLength: 3500,
            description: 'Texto para el cliente con el enlace de la moto. '
                + 'El catálogo contiene todas las motos devueltas para la marca: '
                + 'compará modelo, presupuesto y demás preferencias del cliente para elegir la mejor respuesta; '
                + 'no asumas que todas coinciden. Si imagenUrl no es null, máximo 1024 caracteres.',
        },
        imagenUrl: {
            type: ['string', 'null'],
            description: 'Al ofrecer una moto concreta, copiá la URL de su foto de portada '
                + 'desde catalogo.vehiculos[].fotos (portada true; si no hay, la primera foto). '
                + 'null si no hay foto o no corresponde adjuntar una imagen. No inventes URLs.',
        },
    }),
    resumen: crearEsquemaObjeto({
        resumen: { type: 'string', minLength: 1, maxLength: 4000 },
    }),
};

// Contexto que se envía al LLM.

function obtenerIntervencionesPendientes(conversacion) {
    return (conversacion.accionesExternasRequeridas || [])
        .filter(intervencion => !intervencion.aceptada)
        .slice(-3)
        .map(intervencion => ({
            id: String(intervencion._id),
            detalle: intervencion.detalle.slice(0, 250),
        }));
}

function obtenerVehiculosDelHistorial(mensaje) {
    if (!mensaje.parametroRecibido) {
        return [];
    }

    const catalogo = JSON.parse(mensaje.parametroRecibido);

    if (catalogo.estado !== 'ok') {
        return [];
    }

    return catalogo.vehiculos.slice(0, 8)
        .map(vehiculo => ({
            vehiculoId: vehiculo.vehiculoId || vehiculo._id || vehiculo.id,
            marca: vehiculo.marca,
            modelo: vehiculo.modelo,
            color: vehiculo.color,
            estado: vehiculo.estado,
            enlace: vehiculo.enlace,
        }))
        .filter(vehiculo => vehiculo.vehiculoId);
}

function obtenerTextoOriginal(mensaje) {
    if (mensaje.contenidoOriginal != null) {
        return mensaje.contenidoOriginal;
    }

    if (mensaje.deSistemaParaCliente || (!mensaje.esImagen && !mensaje.esAudio)) {
        return mensaje.contenido || '';
    }

    return '';
}

async function construirContextoConversacion(conversacion, mensaje, mensajesAgrupados) {
    const mensajesRecientes = await Mensaje.find({
        conversacionId: conversacion._id,
        $or: [
            { deSistemaParaCliente: { $ne: true } },
            { whatsappId: { $type: 'string' } },
            { esSimulacion: true },
        ],
    })
        .sort({ createdAt: -1, _id: -1 })
        .limit(12);

    const textoDelBloque = mensajesAgrupados.map(mensajeAgrupado => {
        const partes = [
            '[' + mensajeAgrupado._id + ']',
            obtenerTextoOriginal(mensajeAgrupado),
        ];

        if (mensajeAgrupado.transcripcionAudio) {
            partes.push('Transcripción del audio: ' + mensajeAgrupado.transcripcionAudio);
        }

        if (mensajeAgrupado.transcripcionImagen) {
            partes.push('Descripción de imagen: ' + mensajeAgrupado.transcripcionImagen);
        }

        return partes.filter(Boolean).join('\n');
    }).join('\n');

    const contexto = {
        resumenAnterior: (conversacion.resumen || '').slice(0, 4000),
        buscarVehiculoDisponible: vehiculos.disponible(),
        accionesExternasPendientes: obtenerIntervencionesPendientes(conversacion),
        mensajeActualId: String(mensaje._id),
        mensajeActual: textoDelBloque.slice(-12000),
        mensajes: mensajesRecientes.reverse().map(mensajeReciente => ({
            id: String(mensajeReciente._id),
            autor: mensajeReciente.deSistemaParaCliente ? 'asistente' : 'cliente',
            texto: obtenerTextoOriginal(mensajeReciente).slice(0, 700),
            transcripcionAudio: mensajeReciente.transcripcionAudio?.slice(0, 700),
            inferenciaImagen: mensajeReciente.transcripcionImagen?.slice(0, 700),
            vehiculosConsultados: obtenerVehiculosDelHistorial(mensajeReciente),
        })),
    };

    // Solo se acota el historial. El catálogo de la búsqueda actual se envía completo.
    while (JSON.stringify(contexto).length > 18000 && contexto.mensajes.length > 1) {
        contexto.mensajes.shift();
    }

    return contexto;
}

// Estas referencias las elige el LLM y deben pertenecer al bloque que está atendiendo.
function comprobarMensajesReferenciados(decision, mensajesAgrupados) {
    const idsActuales = new Set(mensajesAgrupados.map(mensaje => String(mensaje._id)));
    const idsReferenciados = [
        ...decision.mensajesFueraDeTema,
        ...decision.solicitudesExternas.map(solicitud => solicitud.mensajeId),
    ];

    if (idsReferenciados.some(id => !idsActuales.has(id))) {
        throw new Error('El LLM hizo referencia a un mensaje ajeno al bloque actual.');
    }

    decision.mensajesFueraDeTema = [...new Set(decision.mensajesFueraDeTema)];
}

function completarMarcaDesdeHistorial(decision, contexto) {
    if (decision.accion !== 'buscar_vehiculo' || decision.filtro.marca) {
        return;
    }

    const marcasCoincidentes = contexto.mensajes
        .flatMap(mensaje => mensaje.vehiculosConsultados)
        .filter(vehiculo => vehiculo.vehiculoId === decision.filtro.vehiculoId && vehiculo.marca)
        .map(vehiculo => vehiculo.marca);

    const marcas = [...new Set(marcasCoincidentes)];

    if (marcas.length === 1) {
        decision.filtro.marca = marcas[0];
        return;
    }

    decision.accion = 'responder';
    decision.motivo = 'Falta identificar la marca. Pedile al cliente qué marca busca antes de consultar el catálogo.';
}

// Espera y agrupación de mensajes.

async function encolarMensajeParaResponder(mensaje) {
    if (mensaje.estadoBot !== 'pendiente') {
        await accionesMensaje.registrar(mensaje, 'esperar_mensajes', 'omitida', {
            motivo: 'El bot estaba inactivo al recibir el mensaje.',
        });
        return;
    }

    await accionesMensaje.registrar(mensaje, 'esperar_mensajes', 'iniciada', {
        segundos: colaMensajes.segundosEspera(mensaje),
    });

    colaMensajes.agregar(mensaje, responderMensajeAutomaticamente);
}

async function cancelarEsperaDeMensajes(conversacionId, motivo = 'Se desactivó el bot.') {
    const mensajesCancelados = colaMensajes.cancelar(conversacionId);

    for (const mensaje of mensajesCancelados) {
        await Mensaje.updateOne(
            { _id: mensaje._id, estadoBot: 'pendiente' },
            { $set: { estadoBot: 'omitido' } },
        );

        if (mensaje.estadoBot === 'pendiente') {
            mensaje.estadoBot = 'omitido';
        }

        await accionesMensaje.registrar(mensaje, 'esperar_mensajes', 'omitida', { motivo });

        const conversacion = await Conversacion.findById(conversacionId);
        await sockets.notificarCambios(conversacion, mensaje);
    }
}

// Cada mensaje fuera de tema se cuenta una sola vez, incluso si se reinicia el turno.
async function registrarConsultasFueraDeTema(conversacionId, mensajesAgrupados, mensajesIds) {
    const ahora = new Date();
    const mensajesFueraDeTema = mensajesAgrupados.filter(mensaje =>
        mensajesIds.includes(String(mensaje._id)),
    );

    for (const mensaje of mensajesFueraDeTema) {
        await Conversacion.updateOne(
            {
                _id: conversacionId,
                'consultasFueraDeTema.mensajeId': { $ne: mensaje._id },
            },
            {
                $push: {
                    consultasFueraDeTema: {
                        fecha: mensaje.createdAt || ahora,
                        mensajeId: mensaje._id,
                    },
                },
            },
            { runValidators: true },
        );
    }

    const conversacion = await Conversacion.findById(conversacionId);
    const inicioUltimas24Horas = ahora.getTime() - 24 * 60 * 60 * 1000;

    const cantidad = (conversacion.consultasFueraDeTema || []).filter(consulta =>
        consulta.fecha.getTime() > inicioUltimas24Horas && consulta.fecha <= ahora,
    ).length;

    return { conversacion, cantidad };
}

// El catálogo es una API controlada: se usa su resultado sin repetir validaciones de estructura.
async function consultarCatalogoPorMarca(mensaje, decision, contexto) {
    if (decision.accion !== 'buscar_vehiculo') {
        await accionesMensaje.registrar(mensaje, 'buscar_vehiculo', 'omitida', {
            motivo: 'El orquestador eligió ' + decision.accion + ': ' + decision.motivo,
            accionElegida: decision.accion,
            catalogoHabilitado: contexto.buscarVehiculoDisponible,
        });

        return { estado: 'no_consultado', vehiculos: [] };
    }

    const filtroCatalogo = { marca: decision.filtro.marca };

    if (contexto.buscarVehiculoDisponible) {
        await accionesMensaje.registrar(mensaje, 'buscar_vehiculo', 'iniciada', {
            filtro: filtroCatalogo,
        });
    }

    let catalogo;
    let errorCatalogo;

    try {
        catalogo = await vehiculos.buscar(filtroCatalogo);
    } catch (error) {
        catalogo = { estado: 'error', vehiculos: [] };
        errorCatalogo = error.message;
    }

    let estadoAccion = 'ok';

    if (catalogo.estado === 'sin_configurar') {
        estadoAccion = 'omitida';
    } else if (catalogo.estado === 'error') {
        estadoAccion = 'error';
    }

    await accionesMensaje.registrar(mensaje, 'buscar_vehiculo', estadoAccion, {
        filtro: filtroCatalogo,
        estadoCatalogo: catalogo.estado,
        cantidad: catalogo.vehiculos.length,
        ...(catalogo.estado === 'sin_configurar' ? { motivo: 'El catálogo está deshabilitado.' } : {}),
        ...(errorCatalogo ? { error: errorCatalogo } : {}),
    });

    if (catalogo.estado === 'sin_configurar' || catalogo.estado === 'error') {
        decision.accion = 'notify_seller';
        decision.motivo = 'No se pudo confirmar la consulta en el catálogo; requiere revisión del vendedor.';

        const solicitudExistente = decision.solicitudesExternas.find(solicitud =>
            solicitud.mensajeId === String(mensaje._id),
        );

        if (solicitudExistente) {
            solicitudExistente.detalle = (solicitudExistente.detalle + ' ' + decision.motivo).slice(0, 1000);
        } else {
            decision.solicitudesExternas.push({
                mensajeId: String(mensaje._id),
                detalle: decision.motivo,
            });
        }
    }

    return catalogo;
}

// Flujo principal: interpretar → controlar fuera de tema → buscar → responder → guardar.
async function responderMensajeAutomaticamente(mensaje, mensajesAgrupados = [mensaje], controlCola = {}) {
    // El reclamo atómico evita que dos procesos respondan al mismo mensaje.
    const mensajeTomado = await Mensaje.findOneAndUpdate(
        { _id: mensaje._id, estadoBot: { $in: ['pendiente', 'fallido'] } },
        {
            $set: { estadoBot: 'procesando' },
            $unset: { errorBot: '' },
        },
        { returnDocument: 'after' },
    );

    if (!mensajeTomado) {
        return;
    }

    mensaje.estadoBot = 'procesando';
    mensaje.errorBot = undefined;

    const tokensDelTurno = { entrada: 0, salida: 0, total: 0 };
    let envioIniciado = false;
    let envioAceptado = false;
    let mensajeEnviado;
    let accionEnCurso;
    let motivoOmision;

    // La cola puede cancelarse o recibir mensajes nuevos mientras se espera al LLM.
    function puedeContinuarRespuesta(conversacion) {
        if (!conversacion?.botActivo || controlCola.cancelada?.()) {
            mensaje.estadoBot = 'omitido';
            motivoOmision = 'El bot se desactivó o se canceló la espera.';
            return false;
        }

        if (controlCola.vigente && !controlCola.vigente()) {
            mensaje.estadoBot = 'pendiente';
            motivoOmision = 'Llegaron más mensajes; se reinicia la espera para responder al bloque completo.';
            return false;
        }

        return true;
    }

    try {
        if (controlCola.desdeCola) {
            await accionesMensaje.registrar(mensaje, 'esperar_mensajes', 'ok', {
                cantidad: mensajesAgrupados.length,
                mensajesIds: mensajesAgrupados.map(mensajeAgrupado => String(mensajeAgrupado._id)),
            });
        }

        let conversacion = await Conversacion.findById(mensaje.conversacionId);

        if (!puedeContinuarRespuesta(conversacion)) {
            return;
        }

        // 1. Preparar el contexto e interpretar la consulta.
        accionEnCurso = 'interpretar';

        await accionesMensaje.registrar(mensaje, 'interpretar', 'iniciada', {
            catalogoHabilitado: vehiculos.disponible(),
        });

        const configuracionPrompts = await prompts.cargar();
        const contexto = await construirContextoConversacion(conversacion, mensaje, mensajesAgrupados);

        if (!puedeContinuarRespuesta(conversacion)) {
            return;
        }

        // Todas las etapas registran su consumo, incluso cuando la llamada falla.
        async function consultarEtapaConLLM(etapa, datos, maxTokensSalida = 1000) {
            const opciones = {
                instrucciones: prompts.instrucciones(configuracionPrompts, etapa),
                esquema: { nombre: etapa, schema: esquemasPorEtapa[etapa] },
                conversacionId: conversacion._id,
                mensajeId: mensaje._id,
                maxTokensSalida,
            };

            if (etapa === 'respuesta' && datos.catalogo.estado === 'ok') {
                opciones.maxCaracteresEntrada = 2_000_000;
            }

            let respuesta;
            let tokensGastados;

            try {
                respuesta = await openai.procesarTexto(JSON.stringify(datos), opciones);
                tokensGastados = respuesta.tokensGastados;
            } catch (error) {
                tokensGastados = error.tokensGastados;
                throw error;
            } finally {
                for (const campo of ['entrada', 'salida', 'total']) {
                    tokensDelTurno[campo] += tokensGastados?.[campo] || 0;
                }
            }

            return respuesta.resultado;
        }

        const decision = await consultarEtapaConLLM('orquestador', contexto);

        comprobarMensajesReferenciados(decision, mensajesAgrupados);
        completarMarcaDesdeHistorial(decision, contexto);

        await accionesMensaje.registrar(mensaje, 'interpretar', 'ok', {
            accionElegida: decision.accion,
            motivo: decision.motivo,
            filtro: decision.filtro,
            catalogoHabilitado: contexto.buscarVehiculoDisponible,
            mensajesFueraDeTema: decision.mensajesFueraDeTema,
            solicitudesExternas: decision.solicitudesExternas,
        });

        accionEnCurso = null;
        conversacion = await Conversacion.findById(mensaje.conversacionId);

        if (!puedeContinuarRespuesta(conversacion)) {
            return;
        }

        // 2. Registrar consultas fuera de tema y pausar el bot si llegó al límite.
        if (decision.mensajesFueraDeTema.length) {
            accionEnCurso = 'registrar_fuera_de_tema';

            await accionesMensaje.registrar(mensaje, accionEnCurso, 'iniciada', {
                mensajesIds: decision.mensajesFueraDeTema,
            });

            const registro = await registrarConsultasFueraDeTema(
                mensaje.conversacionId,
                mensajesAgrupados,
                decision.mensajesFueraDeTema,
            );

            await accionesMensaje.registrar(mensaje, accionEnCurso, 'ok', {
                cantidad24Horas: registro.cantidad,
                mensajesIds: decision.mensajesFueraDeTema,
            });

            await sockets.notificarCambios(registro.conversacion, mensaje);
            accionEnCurso = null;

            if (registro.cantidad >= 3) {
                const motivo = 'Se registraron ' + registro.cantidad
                    + ' consultas fuera de tema en las últimas 24 horas. Requiere revisión del vendedor.';

                accionEnCurso = 'bloquear_bot';

                await accionesMensaje.registrar(mensaje, accionEnCurso, 'iniciada', { motivo });
                await accionesExternas.requerir(mensaje.conversacionId, motivo, mensaje._id);
                await Conversacion.updateOne(
                    { _id: mensaje.conversacionId },
                    { $set: { botActivo: false } },
                );
                await cancelarEsperaDeMensajes(mensaje.conversacionId, motivo);

                mensaje.estadoBot = 'derivado';
                mensaje.accionEjecutada = 'notify_seller';
                mensaje.parametroEjecutado = JSON.stringify(decision.filtro);
                mensaje.parametroRecibido = JSON.stringify({ estado: 'no_consultado', vehiculos: [] });

                await accionesMensaje.registrar(mensaje, accionEnCurso, 'ok', {
                    cantidad24Horas: registro.cantidad,
                    motivo,
                });

                accionEnCurso = null;
                motivoOmision = motivo;
                return;
            }

            if (decision.mensajesFueraDeTema.length === mensajesAgrupados.length) {
                decision.accion = 'responder';
                decision.filtro = {
                    marca: null,
                    modelo: null,
                    precioMinimo: null,
                    precioMaximo: null,
                    vehiculoId: null,
                };
                decision.motivo = 'Consulta fuera de tema: orientar al cliente a las consultas del comercio.';
                decision.solicitudesExternas = [];
            }
        }

        // 3. Consultar todas las motos de la marca y registrar intervenciones pendientes.
        accionEnCurso = 'buscar_vehiculo';
        const catalogo = await consultarCatalogoPorMarca(mensaje, decision, contexto);
        accionEnCurso = null;

        mensaje.accionEjecutada = decision.accion;
        mensaje.parametroEjecutado = JSON.stringify(
            decision.accion === 'buscar_vehiculo' ? { marca: decision.filtro.marca } : decision.filtro,
        );
        mensaje.parametroRecibido = JSON.stringify(catalogo);

        if (decision.accion === 'notify_seller' && !decision.solicitudesExternas.length) {
            decision.solicitudesExternas.push({
                mensajeId: String(mensaje._id),
                detalle: decision.motivo,
            });
        }

        if (decision.solicitudesExternas.length) {
            accionEnCurso = 'solicitar_intervencion';

            await accionesMensaje.registrar(mensaje, accionEnCurso, 'iniciada', {
                solicitudes: decision.solicitudesExternas,
            });

            for (const solicitud of decision.solicitudesExternas) {
                conversacion = await accionesExternas.requerir(
                    mensaje.conversacionId,
                    solicitud.detalle,
                    solicitud.mensajeId,
                );
            }

            contexto.accionesExternasPendientes = obtenerIntervencionesPendientes(conversacion);

            await accionesMensaje.registrar(mensaje, accionEnCurso, 'ok', {
                solicitudes: decision.solicitudesExternas,
            });
            await sockets.notificarCambios(conversacion, mensaje);
        }

        // 4. Redactar la respuesta. La foto elegida por el LLM debe salir de este catálogo.
        accionEnCurso = 'generar_respuesta';
        await accionesMensaje.registrar(mensaje, accionEnCurso, 'iniciada');

        const respuesta = await consultarEtapaConLLM('respuesta', {
            ...contexto,
            decision,
            catalogo,
        });

        const textoRespuesta = respuesta.mensaje.trim();
        const imagenUrl = respuesta.imagenUrl;
        const fotoDelCatalogo = imagenUrl && catalogo.vehiculos.some(vehiculo =>
            vehiculo.fotos?.some(foto => foto.url === imagenUrl),
        );

        if (imagenUrl && !fotoDelCatalogo) {
            throw new Error('La imagen elegida por el LLM no pertenece al catálogo consultado.');
        }

        await accionesMensaje.registrar(mensaje, accionEnCurso, 'ok');

        // 5. Enviar y guardar una sola respuesta, respetando el cupo y el estado de la cola.
        accionEnCurso = 'responder';
        await accionesMensaje.registrar(mensaje, accionEnCurso, 'iniciada');

        await envios.serializar(async function enviarYGuardarRespuesta() {
            conversacion = await Conversacion.findById(mensaje.conversacionId);

            if (!puedeContinuarRespuesta(conversacion)) {
                return;
            }

            if (conversacion.canal !== 'simulador') await envios.verificarLimiteMensual();

            if (!puedeContinuarRespuesta(conversacion)) {
                return;
            }

            mensaje.estadoBot = 'enviando';
            await mensaje.save();

            if (!puedeContinuarRespuesta(conversacion)) {
                return;
            }

            envioIniciado = true;

            const respuestaWhatsApp = await envios.enviarPorCanal(conversacion, {
                to: conversacion.telefono,
                text: textoRespuesta,
                phoneNumberId: mensaje.mediaPhoneNumberId,
                replyToMessageId: mensaje.whatsappId,
                ...(imagenUrl ? { imageUrl: imagenUrl } : {}),
            });

            const whatsappId = respuestaWhatsApp?.messages?.[0]?.id;

            envioAceptado = true;

            await accionesMensaje.registrar(mensaje, 'responder', 'ok', {
                whatsappId,
                simulado: conversacion.canal === 'simulador',
                tipo: imagenUrl ? 'image' : 'text',
                ...(imagenUrl ? { imagenUrl } : {}),
            });

            accionEnCurso = 'guardar_respuesta';

            const fechaEmitida = new Date();

            mensajeEnviado = await Mensaje.create({
                conversacionId: conversacion._id,
                esSimulacion: conversacion.canal === 'simulador',
                versionSimulador: mensaje.esSimulacion ? mensaje.versionSimulador : undefined,
                whatsappId,
                respuestaA: mensaje._id,
                respuestaAutomatica: true,
                deSistemaParaCliente: true,
                deClienteParaSistema: false,
                emisor: mensaje.receptor,
                receptor: conversacion.telefono,
                contenido: textoRespuesta,
                mediaPhoneNumberId: mensaje.mediaPhoneNumberId,
                usoLLM: true,
                fechaEmitida,
                bonificadoReferral: envios.bonificadoReferral(conversacion, fechaEmitida),
                crudo: respuestaWhatsApp,
                ...(imagenUrl ? { esImagen: true, imagenUrl } : {}),
            });

            mensaje.estadoBot = 'respondido';

            await Conversacion.updateOne(
                { _id: conversacion._id },
                {
                    $set: {
                        deClienteParaSistema: false,
                        ultimoMensaje: mensajeEnviado.toObject(),
                    },
                    $inc: { turnosDesdeResumen: 1 },
                },
            );

            const conversacionActualizada = await Conversacion.findById(conversacion._id);
            await sockets.notificarCambios(conversacionActualizada, mensajeEnviado);

            accionEnCurso = null;
        });

        if (!mensajeEnviado) {
            return;
        }

        // 6. Actualizar el resumen. Un fallo aquí no vuelve a enviar la respuesta.
        try {
            conversacion = await Conversacion.findById(conversacion._id);

            const frecuenciaResumen = Number(process.env.BOT_RESUMEN_CADA_TURNOS || 5);
            const correspondeResumir = Number.isSafeInteger(frecuenciaResumen)
                && frecuenciaResumen > 0
                && conversacion.turnosDesdeResumen >= frecuenciaResumen;

            if (correspondeResumir) {
                await accionesMensaje.registrar(mensaje, 'actualizar_resumen', 'iniciada');

                const contextoActualizado = await construirContextoConversacion(
                    conversacion,
                    mensaje,
                    mensajesAgrupados,
                );
                const memoria = await consultarEtapaConLLM('resumen', contextoActualizado, 1300);

                await Conversacion.updateOne(
                    { _id: conversacion._id },
                    { $set: { resumen: memoria.resumen, turnosDesdeResumen: 0 } },
                );
                await accionesMensaje.registrar(mensaje, 'actualizar_resumen', 'ok');
            }
        } catch (error) {
            await accionesMensaje.registrar(mensaje, 'actualizar_resumen', 'error', {
                error: error.message,
            });
            console.error('No se pudo actualizar el resumen:', error.message);
        }
    } catch (error) {
        // Un envío sin confirmación queda incierto y no se reintenta automáticamente.
        mensaje.estadoBot = 'fallido';

        if (envioIniciado && !error.envioNoIniciado) {
            mensaje.estadoBot = envioAceptado ? 'respondido' : 'envio_incierto';
        }

        mensaje.errorBot = error.message;

        await accionesMensaje.registrar(mensaje, accionEnCurso || 'procesar_respuesta', 'error', {
            error: error.message,
            envioIniciado,
            envioAceptado,
        });

        const conversacion = await Conversacion.findById(mensaje.conversacionId);

        if (envioIniciado || conversacion?.botActivo) {
            await accionesExternas.requerir(mensaje.conversacionId, error.message, mensaje._id);
        } else {
            mensaje.estadoBot = 'omitido';
        }

        console.error('No se pudo completar la respuesta automática:', error.message);
    } finally {
        // Persistir el consumo y cerrar el bloque también cuando se cancela o falla el turno.
        if (motivoOmision) {
            if (accionEnCurso && accionEnCurso !== 'responder') {
                await accionesMensaje.registrar(mensaje, accionEnCurso, 'omitida', {
                    motivo: motivoOmision,
                });
            }

            await accionesMensaje.registrar(mensaje, 'responder', 'omitida', {
                motivo: motivoOmision,
            });
        }

        const incrementoTokensConversacion = {};

        for (const campo of ['entrada', 'salida', 'total']) {
            mensaje.set('tokens.' + campo, (mensaje.tokens?.[campo] || 0) + tokensDelTurno[campo]);
            incrementoTokensConversacion['tokens.' + campo] = tokensDelTurno[campo];
        }

        mensaje.usoLLM = mensaje.usoLLM || tokensDelTurno.total > 0;
        await mensaje.save();

        await Conversacion.updateOne(
            { _id: mensaje.conversacionId },
            { $inc: incrementoTokensConversacion },
        );

        const conversacion = await Conversacion.findById(mensaje.conversacionId);
        await sockets.notificarCambios(conversacion, mensaje);

        if (mensaje.estadoBot !== 'pendiente') {
            const mensajesAnteriores = mensajesAgrupados.filter(mensajeAgrupado =>
                String(mensajeAgrupado._id) !== String(mensaje._id),
            );

            for (const mensajeAnterior of mensajesAnteriores) {
                mensajeAnterior.estadoBot = mensaje.estadoBot === 'omitido' ? 'omitido' : 'agrupado';
                await mensajeAnterior.save();

                await accionesMensaje.registrar(mensajeAnterior, 'agrupar_mensajes', 'ok', {
                    mensajePrincipalId: String(mensaje._id),
                    estadoPrincipal: mensaje.estadoBot,
                });

                const conversacionActualizada = await Conversacion.findById(mensaje.conversacionId);
                await sockets.notificarCambios(conversacionActualizada, mensajeAnterior);
            }
        }
    }

    return mensajeEnviado;
}

// Conserva los nombres públicos que usan el orquestador y el control del panel.
module.exports = {
    responder: responderMensajeAutomaticamente,
    encolar: encolarMensajeParaResponder,
    cancelarEspera: cancelarEsperaDeMensajes,
};
