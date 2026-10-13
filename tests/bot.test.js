const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');

function preparar(t, opciones = {}) {
    const entorno = ['WHATSAPP_MONTHLY_RESPONSE_LIMIT', 'BOT_RESUMEN_CADA_TURNOS'].map(nombre => [nombre, process.env[nombre]]);
    t.after(() => entorno.forEach(([nombre, valor]) => { if (valor === undefined) delete process.env[nombre]; else process.env[nombre] = valor; }));
    process.env.WHATSAPP_MONTHLY_RESPONSE_LIMIT = String(opciones.limite ?? 2000);
    process.env.BOT_RESUMEN_CADA_TURNOS = String(opciones.cada ?? 5);
    t.mock.method(console, 'error', () => {});
    const conversacion = new Conversacion({ telefono: '5491112345678', botActivo: opciones.activo ?? true, resumen: 'Cliente busca una Corven.' });
    const entrada = new Mensaje({ conversacionId: conversacion._id, whatsappId: 'wamid.entrada', deClienteParaSistema: true,
        contenidoOriginal: 'Hola', estadoBot: opciones.estado ?? 'pendiente', mediaPhoneNumberId: 'numero-test' });
    entrada.save = async () => entrada;
    const mensajes = [entrada], llamadas = [], envios = [], cambios = [], busquedas = [];
    const accionesPersistidas = new Map();
    function actualizar(update) {
        for (const [campo, valor] of Object.entries(update.$set || {})) conversacion.set(campo, valor);
        for (const [campo, valor] of Object.entries(update.$inc || {})) conversacion.set(campo, (conversacion.get(campo) || 0) + valor);
        for (const [campo, valor] of Object.entries(update.$push || {})) conversacion[campo].push(valor);
        return conversacion;
    }
    const filtro = { marca: null, modelo: null, precioMinimo: null, precioMaximo: null, vehiculoId: null };
    const mocks = {
        '../models/conversacion': { findById: async () => conversacion,
            updateOne: async (query, update) => {
                const distinto = query['consultasFueraDeTema.mensajeId']?.$ne;
                if (distinto && conversacion.consultasFueraDeTema.some(item => String(item.mensajeId) === String(distinto))) return;
                return actualizar(update);
            }, findOneAndUpdate: async (query, update) => {
                const distinto = query['accionesExternasRequeridas._id']?.$ne;
                if (distinto && conversacion.accionesExternasRequeridas.some(item => String(item._id) === String(distinto))) return null;
                return actualizar(update);
            } },
        '../models/mensaje': {
            updateOne: async ({ _id }, update) => {
                if (update.$push?.acciones) {
                    const id = String(_id);
                    accionesPersistidas.set(id, [...(accionesPersistidas.get(id) || []), update.$push.acciones]);
                }
            },
            find: () => ({ sort: () => ({ limit: async cantidad => [...mensajes].reverse().slice(0, cantidad) }) }),
            findOneAndUpdate: async (query, update) => {
                const mensaje = mensajes.find(item => String(item._id) === String(query._id));
                if (!mensaje || !query.estadoBot.$in.includes(mensaje.estadoBot)) return null;
                Object.assign(mensaje, update.$set); return mensaje;
            },
            create: async datos => { const mensaje = new Mensaje(datos); await mensaje.validate(); mensajes.push(mensaje); return mensaje; },
        },
        './envios': {
            serializar: require('../services/envios').serializar,
            bonificadoReferral: require('../services/envios').bonificadoReferral,
            verificarLimiteMensual: async () => {
                const cantidad = mensajes.filter(item => item.deSistemaParaCliente && item.whatsappId).length;
                if (cantidad >= Number(process.env.WHATSAPP_MONTHLY_RESPONSE_LIMIT)) {
                    throw new Error('Se alcanzó el límite mensual de respuestas de WhatsApp.');
                }
            },
        },
        './prompts': { cargar: async () => ({ base: 'Reglas', comercio: 'Datos', orquestador: 'Seleccionar', respuesta: 'Responder', resumen: 'Resumir' }),
            instrucciones: (config, etapa) => [config.base, config.comercio, config[etapa]].join('\n') },
        './openai': { procesarTexto: async (texto, config) => {
            llamadas.push({ datos: JSON.parse(texto), config });
            const etapa = config.esquema.nombre;
            await opciones.duranteConsulta?.(etapa);
            if (opciones.fallarEtapa === etapa) throw new Error('Error de prueba en ' + etapa);
            let resultado;
            if (etapa === 'orquestador') resultado = { mensajesFueraDeTema: [], solicitudesExternas: [], ...(opciones.decision || { accion: 'responder', filtro, motivo: 'Saludo' }) };
            if (etapa === 'respuesta') {
                if (opciones.apagarDuranteGeneracion) conversacion.botActivo = false;
                resultado = { mensaje: opciones.respuesta || 'Hola, ¿qué moto te interesa?' };
            }
            if (etapa === 'resumen') {
                if (opciones.fallarResumen) throw new Error('Resumen agotado');
                resultado = { resumen: 'Cliente consultó por Corven; falta modelo.' };
            }
            return { resultado, tokensGastados: { entrada: 10, salida: 5, total: 15 } };
        } },
        './vehiculos': { disponible: () => opciones.catalogo ?? false, buscar: async filtro => {
            busquedas.push({ ...filtro });
            if (opciones.fallarCatalogo) throw new Error('HTTP 503 en catálogo');
            if (!opciones.catalogo) return { estado: 'sin_configurar', vehiculos: [] };
            return { estado: 'ok', vehiculos: opciones.vehiculos || [{ marca: filtro.marca, modelo: filtro.modelo, precio: 100, moneda: 'ARS' }] };
        } },
        './whatsapp': { enviarMensaje: async datos => {
            envios.push(datos); if (opciones.fallarEnvio) throw new Error('Tiempo de espera agotado');
            return { messages: [{ id: envios.length === 1 ? 'wamid.salida' : 'wamid.salida.' + envios.length }] };
        } },
        './sockets': { notificarCambios: async (conv, mensaje) => cambios.push({ conversacion: conv?.toObject(), mensaje: mensaje.toObject() }) },
    };
    const archivoAcciones = path.resolve(__dirname, '../services/accionesMensaje.js');
    const moduloAcciones = new Module(archivoAcciones);
    moduloAcciones.require = nombre => mocks[nombre];
    moduloAcciones._compile(fs.readFileSync(archivoAcciones, 'utf8'), archivoAcciones);
    mocks['./accionesMensaje'] = moduloAcciones.exports;
    const archivoExternas = path.resolve(__dirname, '../services/accionesExternas.js');
    const moduloExternas = new Module(archivoExternas);
    moduloExternas.require = nombre => mocks[nombre] || require(nombre);
    moduloExternas._compile(fs.readFileSync(archivoExternas, 'utf8'), archivoExternas);
    mocks['./accionesExternas'] = moduloExternas.exports;
    const filename = path.resolve(__dirname, '../services/bot.js'), modulo = new Module(filename), original = createRequire(filename);
    modulo.require = nombre => mocks[nombre] || original(nombre);
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    return { api: modulo.exports, conversacion, entrada, mensajes, llamadas, envios, cambios, busquedas, accionesPersistidas };
}
test('el bot activo selecciona, responde y registra un único envío con consumo', async t => {
    const { api, entrada, llamadas, envios, mensajes, conversacion, cambios } = preparar(t);
    await Promise.all([api.responder(entrada), api.responder(entrada)]);
    assert.equal(llamadas.length, 2);
    assert.equal(envios.length, 1);
    assert.equal(envios[0].phoneNumberId, 'numero-test');
    assert.equal(envios[0].replyToMessageId, 'wamid.entrada');
    assert.equal(mensajes[1].respuestaAutomatica, true);
    assert.equal(String(mensajes[1].respuestaA), String(entrada._id));
    assert.equal(entrada.estadoBot, 'respondido');
    assert.equal(entrada.tokens.total, 30);
    assert.equal(conversacion.tokens.total, 30);
    assert.equal(conversacion.ultimoMensaje.whatsappId, 'wamid.salida');
    assert.match(llamadas[0].config.instrucciones, /Reglas\nDatos\nSeleccionar/);
    assert.match(llamadas[1].config.instrucciones, /Responder/);
    assert(llamadas.every(llamada => String(llamada.config.mensajeId) === String(entrada._id)));
    assert.equal(llamadas[0].datos.resumenAnterior, 'Cliente busca una Corven.');
    assert.equal(cambios.some(item => item.mensaje.respuestaAutomatica), true);
    await api.responder(entrada);
    assert.equal(envios.length, 1);
});
test('cada respuesta automática guarda su gracia al enviarse y mantiene esa marca ante un nuevo referral', async t => {
    for (const dentro of [true, false]) {
        const { api, conversacion, entrada, mensajes } = preparar(t);
        conversacion.referralFecha = new Date(Date.now() - (dentro ? 1 : 73) * 60 * 60 * 1000);
        await api.responder(entrada);
        const salida = mensajes.find(item => item.respuestaAutomatica);
        assert.equal(salida.bonificadoReferral, dentro);
        conversacion.referralFecha = new Date();
        assert.equal(salida.bonificadoReferral, dentro);
        assert.equal(conversacion.ultimoMensaje.bonificadoReferral, dentro);
    }
});

test('el bot apagado no consume IA ni envía; activar después no responde mensajes omitidos', async t => {
    const { api, entrada, llamadas, envios, conversacion } = preparar(t, { activo: false });
    await api.responder(entrada);
    assert.equal(entrada.estadoBot, 'omitido');
    conversacion.botActivo = true;
    await api.responder(entrada);
    assert.equal(llamadas.length, 0);
    assert.equal(envios.length, 0);
});
test('si se apaga durante la generación, no envía y conserva el consumo', async t => {
    const { api, entrada, envios } = preparar(t, { apagarDuranteGeneracion: true });
    await api.responder(entrada);
    assert.equal(entrada.estadoBot, 'omitido');
    assert.equal(envios.length, 0);
    assert.equal(entrada.tokens.total, 30);
});
test('sin catálogo registra una intervención pendiente y mantiene el bot activo', async t => {
    const { api, entrada, conversacion, llamadas, envios } = preparar(t, { decision: {
        accion: 'buscar_vehiculo', filtro: { marca: 'Corven', modelo: 'XXX', precioMinimo: null, precioMaximo: null, vehiculoId: null }, motivo: 'Consulta precio' } });
    await api.responder(entrada);
    assert.equal(llamadas[1].datos.catalogo.estado, 'sin_configurar');
    assert.equal(llamadas[1].datos.decision.accion, 'notify_seller');
    assert.equal(entrada.estadoBot, 'respondido');
    assert.equal(conversacion.botActivo, true);
    assert.equal(conversacion.accionesExternasRequeridas.length, 1);
    assert.equal(conversacion.accionesExternasRequeridas[0].aceptada, false);
    assert.equal(envios.length, 1);
    assert(entrada.acciones.some(item => item.accion === 'buscar_vehiculo' && item.estado === 'omitida' && item.detalle.estadoCatalogo === 'sin_configurar'));
});
test('un envío incierto no se reintenta y el límite mensual evita el envío', async t => {
    const opciones = { fallarEnvio: true };
    const incierto = preparar(t, opciones);
    await incierto.api.responder(incierto.entrada);
    assert.equal(incierto.entrada.estadoBot, 'envio_incierto');
    assert.equal(incierto.conversacion.accionesExternasRequeridas.length, 1);
    assert.equal(incierto.conversacion.botActivo, true);
    await incierto.api.responder(incierto.entrada);
    assert.equal(incierto.envios.length, 1);
    assert.equal(incierto.mensajes.length, 1);
    assert(incierto.entrada.acciones.some(item => item.accion === 'responder' && item.estado === 'error' && item.detalle.envioAceptado === false));
    assert.equal(incierto.entrada.acciones.some(item => item.accion === 'responder' && item.estado === 'ok'), false);
    opciones.fallarEnvio = false;
    const siguiente = new Mensaje({ conversacionId: incierto.conversacion._id, whatsappId: 'wamid.siguiente',
        contenidoOriginal: 'A qué hora puedo pasar?', deClienteParaSistema: true, estadoBot: 'pendiente' });
    siguiente.save = async () => siguiente;
    incierto.mensajes.push(siguiente);
    await incierto.api.responder(siguiente);
    assert.equal(siguiente.estadoBot, 'respondido');
    assert.equal(incierto.conversacion.botActivo, true);
    assert.equal(incierto.conversacion.accionesExternasRequeridas.length, 1);
    assert.equal(incierto.envios.length, 2);
    assert.equal(incierto.entrada.estadoBot, 'envio_incierto');
    const limitado = preparar(t, { limite: 0 });
    await limitado.api.responder(limitado.entrada);
    assert.equal(limitado.envios.length, 0);
    assert.match(limitado.entrada.errorBot, /límite mensual/);
    assert.equal(limitado.conversacion.botActivo, true);
});

test('una respuesta manual confirmada ocupa un cupo antes de la respuesta automática', async t => {
    const { api, entrada, mensajes, envios } = preparar(t, { limite: 1 });
    mensajes.push(new Mensaje({ deSistemaParaCliente: true, respuestaAutomatica: false,
        whatsappId: 'wamid.manual', fechaEmitida: new Date() }));
    await api.responder(entrada);
    assert.equal(envios.length, 0);
    assert.match(entrada.errorBot, /límite mensual/);
});
test('el resumen usa el historial y un fallo de memoria no repite una respuesta', async t => {
    const valido = preparar(t, { cada: 1 });
    await valido.api.responder(valido.entrada);
    assert.equal(valido.conversacion.resumen, 'Cliente consultó por Corven; falta modelo.');
    assert.equal(valido.conversacion.turnosDesdeResumen, 0);
    assert.equal(valido.entrada.tokens.total, 45);
    assert.equal(valido.llamadas[2].datos.mensajes.at(-1).autor, 'asistente');
    const fallido = preparar(t, { cada: 1, fallarResumen: true });
    await fallido.api.responder(fallido.entrada);
    assert.equal(fallido.entrada.estadoBot, 'respondido');
    await fallido.api.responder(fallido.entrada);
    assert.equal(fallido.envios.length, 1);
});

test('una preferencia de color se conserva para redactar después de consultar el catálogo', async t => {
    const enlace = 'https://rpsbikes.com.ar/moto/navi';
    const filtro = { marca: 'Honda', modelo: 'Navi', precioMinimo: null, precioMaximo: null, vehiculoId: null };
    const { api, entrada, llamadas, mensajes, conversacion } = preparar(t, {
        catalogo: true,
        decision: { accion: 'buscar_vehiculo', filtro, motivo: 'Consulta de precio con preferencia de color.' },
        vehiculos: [{ marca: 'Honda', modelo: 'Navi', color: 'Blanco', precio: 100, disponible: true, enlace }],
        respuesta: 'Tengo una Honda Navi blanca disponible. Su precio es 100. ' + enlace,
    });
    entrada.contenidoOriginal = 'Quiero una Honda Navi blanca, ¿en qué precio la tenés?';
    await api.responder(entrada);
    assert.equal(llamadas.length, 2);
    assert.equal(llamadas[0].config.esquema.nombre, 'orquestador');
    assert.deepEqual(Object.keys(llamadas[0].config.esquema.schema.properties.filtro.properties).sort(),
        ['marca', 'modelo', 'precioMaximo', 'precioMinimo', 'vehiculoId']);
    assert.equal(llamadas[1].config.esquema.nombre, 'respuesta');
    assert.equal(llamadas[1].datos.mensajes.at(-1).texto, entrada.contenidoOriginal);
    assert.deepEqual(llamadas[1].datos.decision.filtro, filtro);
    assert.equal(llamadas[1].datos.catalogo.estado, 'ok');
    assert.equal(llamadas[1].datos.catalogo.vehiculos[0].color, 'Blanco');
    assert.equal(llamadas[1].datos.catalogo.vehiculos[0].enlace, enlace);
    assert.equal(entrada.accionEjecutada, 'buscar_vehiculo');
    assert.equal(conversacion.botActivo, true);
    assert.equal(mensajes[1].contenido.includes(enlace), true);
    assert.deepEqual(entrada.acciones.filter(item => item.estado === 'ok').map(item => item.accion),
        ['interpretar', 'buscar_vehiculo', 'generar_respuesta', 'responder']);
    const interpretacion = entrada.acciones.find(item => item.accion === 'interpretar' && item.estado === 'ok');
    assert.equal(interpretacion.detalle.catalogoHabilitado, true);
    assert.equal(interpretacion.detalle.accionElegida, 'buscar_vehiculo');
    const busqueda = entrada.acciones.find(item => item.accion === 'buscar_vehiculo' && item.estado === 'ok');
    assert.equal(busqueda.detalle.cantidad, 1);
    assert.equal(busqueda.detalle.estadoCatalogo, 'ok');
    assert.equal(entrada.acciones.at(-1).detalle.whatsappId, 'wamid.salida');
});

test('una consulta por Honda Navi compara el estado con el catálogo después de buscar solo marca y modelo', async t => {
    for (const consulta of ['Tenés Honda Navi?', 'Tenés Honda Navi nueva?']) {
        const filtro = { marca: 'Honda', modelo: 'Navi', precioMinimo: null, precioMaximo: null, vehiculoId: null };
        const usada = { marca: 'Honda', modelo: 'Navi', estado: 'usado', color: 'Rojo', disponible: true,
            detalle: 'Muy buen estado', observacionesInternas: 'Entrega sujeta a revisión de taller.',
            precio: 1800000, moneda: 'ARS', enlace: 'https://rpsbikes.com.ar/moto/navi-usada' };
        const { api, entrada, llamadas, busquedas, conversacion } = preparar(t, { catalogo: true,
            decision: { accion: 'buscar_vehiculo', filtro, motivo: 'Consulta Honda Navi.' }, vehiculos: [usada] });
        entrada.contenidoOriginal = consulta;
        await api.responder(entrada);
        assert.deepEqual(busquedas, [filtro]);
        assert.equal(llamadas[1].config.esquema.nombre, 'respuesta');
        assert.match(llamadas[1].datos.mensajeActual, new RegExp(consulta.replace('?', '\\?')));
        assert.deepEqual(llamadas[1].datos.catalogo.vehiculos, [usada]);
        assert.equal(llamadas[1].datos.catalogo.vehiculos[0].observacionesInternas, usada.observacionesInternas);
        assert.equal(JSON.parse(entrada.parametroRecibido).vehiculos[0].observacionesInternas, usada.observacionesInternas);
        assert.equal(entrada.accionEjecutada, 'buscar_vehiculo');
        assert.equal(conversacion.accionesExternasRequeridas.length, 0);
        assert.equal(conversacion.botActivo, true);
    }
});

test('un presupuesto permite buscar sin marca ni modelo y conserva los límites numéricos', async t => {
    const filtro = { marca: null, modelo: null, precioMinimo: 0, precioMaximo: 2000000, vehiculoId: null };
    const { api, entrada, llamadas, busquedas } = preparar(t, { catalogo: true,
        decision: { accion: 'buscar_vehiculo', filtro, motivo: 'Presupuesto máximo de dos millones.' } });
    entrada.contenidoOriginal = 'Qué motos tenés hasta dos millones?';
    await api.responder(entrada);
    assert.deepEqual(busquedas, [filtro]);
    assert.deepEqual(JSON.parse(entrada.parametroEjecutado), filtro);
    assert.deepEqual(llamadas[1].datos.decision.filtro, filtro);
    assert.equal(entrada.estadoBot, 'respondido');
});

test('un ID de vehículo permite consultar la moto concreta y las referencias anteriores llegan al LLM', async t => {
    const vehiculoId = '507f1f77bcf86cd799439011';
    for (const campoId of ['_id', 'id', 'vehiculoId']) {
        const filtro = { marca: null, modelo: null, precioMinimo: null, precioMaximo: null, vehiculoId };
        const { api, entrada, mensajes, llamadas, busquedas } = preparar(t, { catalogo: true,
            decision: { accion: 'buscar_vehiculo', filtro, motivo: 'Verificar el precio de la moto roja consultada.' } });
        const anterior = new Mensaje({ conversacionId: entrada.conversacionId, deClienteParaSistema: true,
            contenidoOriginal: 'Tenés Honda Navi?', parametroRecibido: JSON.stringify({ estado: 'ok', vehiculos: [
                { [campoId]: vehiculoId, marca: 'Honda', modelo: 'Navi', color: 'Rojo', credencial: 'secreto' },
                { _id: 'no-es-un-id', marca: 'Otra' },
            ] }) });
        const sinCatalogo = new Mensaje({ conversacionId: entrada.conversacionId, deClienteParaSistema: true, parametroRecibido: 'JSON anterior inválido' });
        mensajes.unshift(anterior, sinCatalogo);
        entrada.contenidoOriginal = 'Qué precio tiene esa Navi roja?';
        await api.responder(entrada);
        assert.deepEqual(busquedas, [filtro]);
        assert.deepEqual(JSON.parse(entrada.parametroEjecutado), filtro);
        assert.deepEqual(llamadas[0].datos.mensajes.find(item => item.id === String(anterior._id)).vehiculosConsultados,
            [{ vehiculoId, marca: 'Honda', modelo: 'Navi', color: 'Rojo' }]);
        assert.deepEqual(llamadas[0].datos.mensajes.find(item => item.id === String(sinCatalogo._id)).vehiculosConsultados, []);
        assert.equal(entrada.estadoBot, 'respondido');
    }
});

test('precios inválidos y filtros anteriores se rechazan antes de consultar el catálogo', async t => {
    for (const cambio of [{ precioMinimo: -1 }, { precioMaximo: '2000000' }, { precioMaximo: Infinity },
        { precioMinimo: 200, precioMaximo: 100 }, { estado: 'nuevo' }, { vehiculo: 'moto' }, { tipo: 'urbana' }, { color: 'rojo' },
        { vehiculoId: 'no-es-un-id' }, { vehiculoId: 'g'.repeat(24) }, { vehiculoId: 123 }, { vehiculoId: { $ne: null } }]) {
        const filtro = { marca: 'Honda', modelo: 'Navi', precioMinimo: null, precioMaximo: null, vehiculoId: null, ...cambio };
        const { api, entrada, busquedas, envios, conversacion } = preparar(t, { catalogo: true,
            decision: { accion: 'buscar_vehiculo', filtro, motivo: 'Consulta catálogo.' } });
        await api.responder(entrada);
        assert.equal(entrada.estadoBot, 'fallido');
        assert.match(entrada.errorBot, /inválido/);
        assert.equal(busquedas.length, 0);
        assert.equal(envios.length, 0);
        assert.equal(conversacion.botActivo, true);
    }
});

test('un bloque de más de doce mensajes llega completo a ambas llamadas y produce un solo envío', async t => {
    const { api, entrada, mensajes, llamadas, envios, conversacion } = preparar(t);
    const anteriores = Array.from({ length: 13 }, (_, i) => {
        const mensaje = new Mensaje({ conversacionId: conversacion._id, deClienteParaSistema: true, estadoBot: 'pendiente',
            contenidoOriginal: i === 0 ? 'Hola, tenés moto Corven?' : 'Pregunta ' + i });
        mensaje.save = async () => mensaje;
        return mensaje;
    });
    entrada.contenidoOriginal = 'Qué precio? Sale patentada?';
    mensajes.unshift(...anteriores);
    await api.responder(entrada, [...anteriores, entrada]);
    assert.equal(envios.length, 1);
    assert.equal(llamadas.length, 2);
    for (const llamada of llamadas) {
        assert.equal(llamada.datos.mensajes.length, 12);
        assert.match(llamada.datos.mensajeActual, /^\[[a-f0-9]{24}\]\nHola, tenés moto Corven\?/);
        assert.match(llamada.datos.mensajeActual, /Qué precio\? Sale patentada\?$/);
    }
    assert(anteriores.every(mensaje => mensaje.estadoBot === 'agrupado'));
    assert(anteriores.every(mensaje => mensaje.acciones.at(-1).detalle.mensajePrincipalId === String(entrada._id)));
    assert.equal(entrada.estadoBot, 'respondido');
    assert.equal(String(mensajes.at(-1).respuestaA), String(entrada._id));
    assert.equal(conversacion.turnosDesdeResumen, 1);
});

test('si llega otro mensaje durante la generación, no envía y el siguiente turno reúne ambos', async t => {
    let vigente = true;
    const { api, entrada, mensajes, llamadas, envios, conversacion } = preparar(t, {
        duranteConsulta: etapa => { if (etapa === 'respuesta') vigente = false; },
    });
    entrada.contenidoOriginal = 'Tenés Corven?';
    await api.responder(entrada, [entrada], { vigente: () => vigente });
    assert.equal(envios.length, 0);
    assert.equal(entrada.estadoBot, 'pendiente');
    assert.equal(entrada.tokens.total, 30);
    assert(entrada.acciones.some(item => item.accion === 'responder' && item.estado === 'omitida' && /Llegaron más mensajes/.test(item.detalle.motivo)));
    const segundo = new Mensaje({ conversacionId: conversacion._id, whatsappId: 'wamid.segundo',
        contenidoOriginal: 'Qué precio?', deClienteParaSistema: true, estadoBot: 'pendiente' });
    segundo.save = async () => segundo;
    mensajes.push(segundo);
    await api.responder(segundo, [entrada, segundo]);
    assert.equal(envios.length, 1);
    assert.equal(envios[0].replyToMessageId, 'wamid.segundo');
    assert.equal(llamadas.at(-1).datos.mensajeActual, '[' + String(entrada._id) + ']\nTenés Corven?\n[' + String(segundo._id) + ']\nQué precio?');
    assert.equal(entrada.estadoBot, 'agrupado');
    assert.equal(segundo.estadoBot, 'respondido');
    assert.equal(conversacion.tokens.total, 60);
});

test('cancelar la espera durante la generación impide enviar aunque el bot se haya reactivado', async t => {
    let cancelada = false;
    const { api, entrada, envios, conversacion } = preparar(t, {
        duranteConsulta: etapa => { if (etapa === 'respuesta') cancelada = true; },
    });
    await api.responder(entrada, [entrada], { vigente: () => !cancelada, cancelada: () => cancelada });
    assert.equal(conversacion.botActivo, true);
    assert.equal(envios.length, 0);
    assert.equal(entrada.estadoBot, 'omitido');
});

test('una derivación previa a buscar deja el motivo y la configuración del catálogo en acciones', async t => {
    const { api, entrada } = preparar(t, { catalogo: true, decision: {
        accion: 'notify_seller', filtro: { marca: 'Honda', modelo: 'Navi', precioMinimo: null, precioMaximo: null, vehiculoId: null },
        motivo: 'El cliente pidió un vendedor.',
    } });
    await api.responder(entrada);
    assert.equal(JSON.parse(entrada.parametroRecibido).estado, 'no_consultado');
    const omitida = entrada.acciones.find(item => item.accion === 'buscar_vehiculo');
    assert.equal(omitida.estado, 'omitida');
    assert.equal(omitida.detalle.catalogoHabilitado, true);
    assert.equal(omitida.detalle.accionElegida, 'notify_seller');
    assert.match(omitida.detalle.motivo, /El cliente pidió un vendedor/);
    assert(entrada.acciones.some(item => item.accion === 'solicitar_intervencion' && item.estado === 'ok'));
});

test('un error de catálogo conserva su causa y luego registra la respuesta y la derivación', async t => {
    const { api, entrada } = preparar(t, { catalogo: true, fallarCatalogo: true, decision: {
        accion: 'buscar_vehiculo', filtro: { marca: 'Honda', modelo: 'Navi', precioMinimo: null, precioMaximo: null, vehiculoId: null }, motivo: 'Consulta precio',
    } });
    await api.responder(entrada);
    const fallida = entrada.acciones.find(item => item.accion === 'buscar_vehiculo' && item.estado === 'error');
    assert.equal(fallida.detalle.error, 'HTTP 503 en catálogo');
    assert.equal(fallida.detalle.estadoCatalogo, 'error');
    assert(entrada.acciones.some(item => item.accion === 'responder' && item.estado === 'ok'));
    assert(entrada.acciones.some(item => item.accion === 'solicitar_intervencion' && item.estado === 'ok'));
});

test('se persiste el inicio antes de llamar al LLM y un fallo identifica la etapa sin registrar un envío', async t => {
    for (const etapa of ['orquestador', 'respuesta']) {
        let escenario;
        const opciones = { fallarEtapa: etapa, duranteConsulta: actual => {
            const nombre = actual === 'orquestador' ? 'interpretar' : 'generar_respuesta';
            assert.equal(escenario.accionesPersistidas.get(String(escenario.entrada._id)).at(-1).accion, nombre);
            assert.equal(escenario.accionesPersistidas.get(String(escenario.entrada._id)).at(-1).estado, 'iniciada');
        } };
        escenario = preparar(t, opciones);
        await escenario.api.responder(escenario.entrada);
        const nombre = etapa === 'orquestador' ? 'interpretar' : 'generar_respuesta';
        const fallida = escenario.entrada.acciones.at(-1);
        assert.equal(fallida.accion, nombre);
        assert.equal(fallida.estado, 'error');
        assert.equal(escenario.envios.length, 0);
        assert.equal(escenario.accionesPersistidas.get(String(escenario.entrada._id)).length, escenario.entrada.acciones.length);
        assert.equal(escenario.conversacion.botActivo, true);
        assert.equal(escenario.conversacion.accionesExternasRequeridas.length, 1);
        opciones.fallarEtapa = null;
        opciones.duranteConsulta = null;
        const siguiente = new Mensaje({ conversacionId: escenario.conversacion._id, whatsappId: 'wamid.siguiente',
            contenidoOriginal: 'Hola', deClienteParaSistema: true, estadoBot: 'pendiente' });
        siguiente.save = async () => siguiente;
        escenario.mensajes.push(siguiente);
        await escenario.api.responder(siguiente);
        assert.equal(siguiente.estadoBot, 'respondido');
        assert.equal(escenario.envios.length, 1);
        assert.equal(escenario.entrada.estadoBot, 'fallido');
        assert.equal(escenario.conversacion.botActivo, true);
    }
});

test('la espera y su cancelación quedan registradas sin consumir IA ni enviar', async t => {
    const { api, entrada, conversacion, llamadas, envios } = preparar(t);
    t.after(() => api.cancelarEspera(conversacion._id));
    await api.encolar(entrada);
    assert.equal(entrada.acciones.at(-1).accion, 'esperar_mensajes');
    assert.equal(entrada.acciones.at(-1).estado, 'iniciada');
    await api.cancelarEspera(conversacion._id, 'Respuesta manual del vendedor.');
    assert.equal(entrada.estadoBot, 'omitido');
    assert.equal(entrada.acciones.at(-1).estado, 'omitida');
    assert.equal(entrada.acciones.at(-1).detalle.motivo, 'Respuesta manual del vendedor.');
    assert.equal(llamadas.length, 0);
    assert.equal(envios.length, 0);
});

function decisionFueraDeTema(ids) {
    return { accion: 'responder', filtro: { marca: null, modelo: null, precioMinimo: null, precioMaximo: null, vehiculoId: null },
        motivo: 'Consulta ajena al comercio.', mensajesFueraDeTema: ids };
}

test('la primera y segunda consulta fuera de tema se acumulan y el bot continúa activo', async t => {
    for (const previas of [0, 1]) {
        const opciones = {};
        const { api, entrada, conversacion, envios, llamadas } = preparar(t, opciones);
        if (previas) conversacion.consultasFueraDeTema.push({ fecha: new Date(), mensajeId: new Mensaje()._id });
        opciones.decision = { ...decisionFueraDeTema([String(entrada._id)]), accion: 'notify_seller' };
        await api.responder(entrada);
        assert.equal(conversacion.consultasFueraDeTema.length, previas + 1);
        assert.equal(String(conversacion.consultasFueraDeTema.at(-1).mensajeId), String(entrada._id));
        assert.equal(conversacion.botActivo, true);
        assert.equal(conversacion.accionesExternasRequeridas.length, 0);
        assert.equal(envios.length, 1);
        assert.equal(llamadas[1].datos.decision.accion, 'responder');
        const registro = entrada.acciones.find(item => item.accion === 'registrar_fuera_de_tema' && item.estado === 'ok');
        assert.equal(registro.detalle.cantidad24Horas, previas + 1);
    }
});

test('la tercera consulta dentro de 24 horas bloquea antes de generar o enviar y requiere vendedor', async t => {
    const opciones = {};
    const { api, entrada, conversacion, envios, llamadas } = preparar(t, opciones);
    const ahora = Date.now();
    conversacion.consultasFueraDeTema.push(
        { fecha: new Date(ahora - 23 * 60 * 60 * 1000), mensajeId: new Mensaje()._id },
        { fecha: new Date(ahora - 60 * 60 * 1000), mensajeId: new Mensaje()._id });
    opciones.decision = decisionFueraDeTema([String(entrada._id)]);
    await api.responder(entrada);
    assert.equal(conversacion.consultasFueraDeTema.length, 3);
    assert.equal(conversacion.botActivo, false);
    assert.equal(conversacion.accionesExternasRequeridas.length, 1);
    assert.match(conversacion.accionesExternasRequeridas[0].detalle, /3 consultas fuera de tema/);
    assert.equal(entrada.estadoBot, 'derivado');
    assert.equal(entrada.accionEjecutada, 'notify_seller');
    assert.equal(llamadas.length, 1);
    assert.equal(envios.length, 0);
    assert(entrada.acciones.some(item => item.accion === 'bloquear_bot' && item.estado === 'ok'));
    assert(entrada.acciones.some(item => item.accion === 'responder' && item.estado === 'omitida'));
    await api.responder(entrada);
    assert.equal(conversacion.consultasFueraDeTema.length, 3);
    assert.equal(conversacion.accionesExternasRequeridas.length, 1);
});

test('tres mensajes fuera de tema agrupados cuentan por sus IDs originales y bloquean juntos', async t => {
    const opciones = {};
    const { api, entrada, conversacion, mensajes, envios } = preparar(t, opciones);
    const anteriores = ['Receta de pizza?', 'Escribime una aplicación'].map(contenidoOriginal => {
        const mensaje = new Mensaje({ conversacionId: conversacion._id, contenidoOriginal, deClienteParaSistema: true, estadoBot: 'pendiente' });
        mensaje.save = async () => mensaje;
        return mensaje;
    });
    entrada.contenidoOriginal = 'Quién gana las elecciones?';
    mensajes.unshift(...anteriores);
    const grupo = [...anteriores, entrada];
    opciones.decision = decisionFueraDeTema(grupo.map(item => String(item._id)));
    await api.responder(entrada, grupo);
    assert.equal(conversacion.consultasFueraDeTema.length, 3);
    assert.equal(new Set(conversacion.consultasFueraDeTema.map(item => String(item.mensajeId))).size, 3);
    assert.equal(conversacion.botActivo, false);
    assert.equal(conversacion.accionesExternasRequeridas.length, 1);
    assert.equal(envios.length, 0);
    assert(anteriores.every(item => item.estadoBot === 'agrupado'));
});

test('las consultas de hace 24 horas o más se conservan pero no cuentan para el bloqueo', async t => {
    const ahora = Date.parse('2026-10-13T15:00:00Z');
    t.mock.method(Date, 'now', () => ahora);
    const opciones = {};
    const { api, entrada, conversacion } = preparar(t, opciones);
    for (const horas of [48, 24, 10]) conversacion.consultasFueraDeTema.push({ fecha: new Date(ahora - horas * 60 * 60 * 1000), mensajeId: new Mensaje()._id });
    opciones.decision = decisionFueraDeTema([String(entrada._id)]);
    await api.responder(entrada);
    assert.equal(conversacion.consultasFueraDeTema.length, 4);
    assert.equal(conversacion.botActivo, true);
    assert.equal(conversacion.accionesExternasRequeridas.length, 0);
    const registro = entrada.acciones.find(item => item.accion === 'registrar_fuera_de_tema' && item.estado === 'ok');
    assert.equal(registro.detalle.cantidad24Horas, 2);
});

test('reiniciar el turno por nuevos mensajes no suma dos veces la misma detección', async t => {
    let vigente = true, interrumpir = true;
    const opciones = { duranteConsulta: etapa => { if (etapa === 'respuesta' && interrumpir) vigente = false; } };
    const { api, entrada, conversacion, envios } = preparar(t, opciones);
    opciones.decision = decisionFueraDeTema([String(entrada._id)]);
    await api.responder(entrada, [entrada], { vigente: () => vigente });
    assert.equal(entrada.estadoBot, 'pendiente');
    assert.equal(conversacion.consultasFueraDeTema.length, 1);
    interrumpir = false;
    vigente = true;
    await api.responder(entrada, [entrada], { vigente: () => vigente });
    assert.equal(conversacion.consultasFueraDeTema.length, 1);
    assert.equal(conversacion.botActivo, true);
    assert.equal(envios.length, 1);
});

test('una consulta comercial no agrega detecciones ni bloquea aunque exista historial previo', async t => {
    const { api, entrada, conversacion } = preparar(t);
    for (let i = 0; i < 3; i++) conversacion.consultasFueraDeTema.push({ fecha: new Date(), mensajeId: new Mensaje()._id });
    await api.responder(entrada);
    assert.equal(conversacion.consultasFueraDeTema.length, 3);
    assert.equal(conversacion.botActivo, true);
    assert.equal(entrada.estadoBot, 'respondido');
    assert.equal(entrada.acciones.some(item => item.accion === 'bloquear_bot'), false);
});

test('el LLM no puede registrar como fuera de tema un mensaje ajeno al bloque actual', async t => {
    const { api, entrada, conversacion } = preparar(t, { decision: decisionFueraDeTema([String(new Mensaje()._id)]) });
    await api.responder(entrada);
    assert.equal(conversacion.consultasFueraDeTema.length, 0);
    assert.match(entrada.errorBot, /Clasificación fuera de tema inválida/);
    assert.equal(entrada.acciones.some(item => item.accion === 'bloquear_bot'), false);
});

test('una solicitud por una usada queda pendiente mientras el bot responde luego precio y horario', async t => {
    const opciones = { catalogo: true };
    const { api, entrada, conversacion, mensajes, envios, llamadas } = preparar(t, opciones);
    const detalle = 'Evaluar si acepta una Rouser 200 usada como parte de pago.';
    entrada.contenidoOriginal = 'Puedo entregar mi Rouser 200 usada?';
    opciones.decision = { accion: 'notify_seller', filtro: { marca: null, modelo: null, precioMinimo: null, precioMaximo: null, vehiculoId: null },
        motivo: detalle, solicitudesExternas: [{ mensajeId: String(entrada._id), detalle }] };
    await api.responder(entrada);
    assert.equal(conversacion.botActivo, true);
    assert.equal(conversacion.accionesExternasRequeridas.length, 1);
    assert.equal(conversacion.accionesExternasRequeridas[0].aceptada, false);
    assert.equal(llamadas.at(-1).datos.accionesExternasPendientes[0].detalle, detalle);
    for (const tipo of ['precio', 'horario']) {
        const nuevo = new Mensaje({ conversacionId: conversacion._id, contenidoOriginal: tipo === 'precio' ? 'Qué precio tiene la Honda Navi?' : 'A qué hora puedo pasar?',
            deClienteParaSistema: true, whatsappId: 'wamid.' + tipo, estadoBot: 'pendiente' });
        nuevo.save = async () => nuevo;
        mensajes.push(nuevo);
        opciones.decision = { accion: tipo === 'precio' ? 'buscar_vehiculo' : 'responder',
            filtro: { marca: tipo === 'precio' ? 'Honda' : null, modelo: tipo === 'precio' ? 'Navi' : null, precioMinimo: null, precioMaximo: null, vehiculoId: null }, motivo: 'Consulta ' + tipo };
        await api.responder(nuevo);
        assert.equal(nuevo.estadoBot, 'respondido');
        assert.equal(conversacion.botActivo, true);
        assert.equal(conversacion.accionesExternasRequeridas.length, 1);
        assert.equal(conversacion.accionesExternasRequeridas[0].aceptada, false);
        assert.equal(llamadas.at(-1).datos.accionesExternasPendientes[0].detalle, detalle);
    }
    assert.equal(envios.length, 3);
});

test('un bloque puede consultar catálogo y solicitar intervención para otro mensaje al mismo tiempo', async t => {
    const opciones = { catalogo: true };
    const { api, entrada, conversacion, mensajes, llamadas, envios } = preparar(t, opciones);
    const usada = new Mensaje({ conversacionId: conversacion._id, contenidoOriginal: 'Quiero entregar una moto usada.', estadoBot: 'pendiente', deClienteParaSistema: true });
    usada.save = async () => usada;
    mensajes.unshift(usada);
    entrada.contenidoOriginal = 'Cuál es el precio de la Honda Navi?';
    opciones.decision = { accion: 'buscar_vehiculo', filtro: { marca: 'Honda', modelo: 'Navi', precioMinimo: null, precioMaximo: null, vehiculoId: null },
        motivo: 'Consulta de precio.', solicitudesExternas: [{ mensajeId: String(usada._id), detalle: 'Evaluar la moto usada como parte de pago.' }] };
    await api.responder(entrada, [usada, entrada]);
    assert.equal(llamadas.at(-1).datos.catalogo.estado, 'ok');
    assert.equal(llamadas.at(-1).datos.decision.solicitudesExternas.length, 1);
    assert.equal(conversacion.accionesExternasRequeridas.length, 1);
    assert.equal(String(conversacion.accionesExternasRequeridas[0]._id), String(usada._id));
    assert.equal(conversacion.botActivo, true);
    assert.equal(envios.length, 1);
});

test('ampliar un bloque durante la generación no duplica la intervención del mismo mensaje', async t => {
    let vigente = true, interrumpir = true;
    const opciones = { duranteConsulta: etapa => { if (etapa === 'respuesta' && interrumpir) vigente = false; } };
    const { api, entrada, conversacion, mensajes } = preparar(t, opciones);
    const solicitud = { mensajeId: String(entrada._id), detalle: 'Evaluar moto usada.' };
    opciones.decision = { accion: 'notify_seller', filtro: { marca: null, modelo: null, precioMinimo: null, precioMaximo: null, vehiculoId: null }, motivo: solicitud.detalle, solicitudesExternas: [solicitud] };
    await api.responder(entrada, [entrada], { vigente: () => vigente });
    assert.equal(entrada.estadoBot, 'pendiente');
    assert.equal(conversacion.accionesExternasRequeridas.length, 1);
    const nuevo = new Mensaje({ conversacionId: conversacion._id, contenidoOriginal: 'A qué hora puedo pasar?', deClienteParaSistema: true, estadoBot: 'pendiente' });
    nuevo.save = async () => nuevo;
    mensajes.push(nuevo);
    interrumpir = false;
    vigente = true;
    await api.responder(nuevo, [entrada, nuevo], { vigente: () => vigente });
    assert.equal(conversacion.accionesExternasRequeridas.length, 1);
    assert.equal(conversacion.botActivo, true);
    assert.equal(nuevo.estadoBot, 'respondido');
});
