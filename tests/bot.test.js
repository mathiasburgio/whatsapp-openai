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
    const mensajes = [entrada], llamadas = [], envios = [], cambios = [];
    function actualizar(update) {
        for (const [campo, valor] of Object.entries(update.$set || {})) conversacion.set(campo, valor);
        for (const [campo, valor] of Object.entries(update.$inc || {})) conversacion.set(campo, (conversacion.get(campo) || 0) + valor);
        for (const [campo, valor] of Object.entries(update.$push || {})) conversacion[campo].push(valor);
        return conversacion;
    }
    const filtro = { marca: null, modelo: null, estado: null, precio_minimo: null, precio_maximo: null };
    const mocks = {
        '../models/conversacion': { findById: async () => conversacion,
            updateOne: async (_, update) => actualizar(update), findOneAndUpdate: async (_, update) => actualizar(update) },
        '../models/mensaje': {
            find: () => ({ sort: () => ({ limit: async () => [...mensajes].reverse() }) }),
            findOneAndUpdate: async (query, update) => {
                if (!query.estadoBot.$in.includes(entrada.estadoBot)) return null;
                Object.assign(entrada, update.$set); return entrada;
            },
            create: async datos => { const mensaje = new Mensaje(datos); await mensaje.validate(); mensajes.push(mensaje); return mensaje; },
        },
        './envios': {
            serializar: require('../services/envios').serializar,
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
            let resultado;
            if (etapa === 'orquestador') resultado = opciones.decision || { accion: 'responder', filtro, motivo: 'Saludo' };
            if (etapa === 'respuesta') {
                if (opciones.apagarDuranteGeneracion) conversacion.botActivo = false;
                resultado = { mensaje: 'Hola, ¿qué moto te interesa?' };
            }
            if (etapa === 'resumen') {
                if (opciones.fallarResumen) throw new Error('Resumen agotado');
                resultado = { resumen: 'Cliente consultó por Corven; falta modelo.' };
            }
            return { resultado, tokensGastados: { entrada: 10, salida: 5, total: 15 } };
        } },
        './vehiculos': { disponible: () => opciones.catalogo ?? false, buscar: async filtro => {
            if (!opciones.catalogo) return { estado: 'sin_configurar', vehiculos: [] };
            return { estado: 'ok', vehiculos: [{ marca: filtro.marca, modelo: filtro.modelo, precio: 100, moneda: 'ARS' }] };
        } },
        './whatsapp': { enviarMensaje: async datos => {
            envios.push(datos); if (opciones.fallarEnvio) throw new Error('Tiempo de espera agotado');
            return { messages: [{ id: 'wamid.salida' }] };
        } },
        './sockets': { notificarCambios: async (conv, mensaje) => cambios.push({ conversacion: conv.toObject(), mensaje: mensaje.toObject() }) },
    };
    const filename = path.resolve(__dirname, '../services/bot.js'), modulo = new Module(filename), original = createRequire(filename);
    modulo.require = nombre => mocks[nombre] || original(nombre);
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    return { api: modulo.exports, conversacion, entrada, mensajes, llamadas, envios, cambios };
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
test('sin catálogo confirma la derivación, pausa el bot y avisa en el panel', async t => {
    const { api, entrada, conversacion, llamadas, envios } = preparar(t, { decision: {
        accion: 'buscar_vehiculo', filtro: { marca: 'Corven', modelo: 'XXX', estado: 'nuevo', precio_minimo: null, precio_maximo: null }, motivo: 'Consulta precio' } });
    await api.responder(entrada);
    assert.equal(llamadas[1].datos.catalogo.estado, 'sin_configurar');
    assert.equal(llamadas[1].datos.decision.accion, 'notify_seller');
    assert.equal(entrada.estadoBot, 'derivado');
    assert.equal(conversacion.botActivo, false);
    assert.equal(conversacion.requiereAtencion, true);
    assert.equal(conversacion.notificacion[0].lead, 'derivación');
    assert.equal(envios.length, 1);
});
test('un envío incierto no se reintenta y el límite mensual evita el envío', async t => {
    const incierto = preparar(t, { fallarEnvio: true });
    await incierto.api.responder(incierto.entrada);
    assert.equal(incierto.entrada.estadoBot, 'envio_incierto');
    assert.equal(incierto.conversacion.requiereAtencion, true);
    await incierto.api.responder(incierto.entrada);
    assert.equal(incierto.envios.length, 1);
    assert.equal(incierto.mensajes.length, 1);
    const limitado = preparar(t, { limite: 0 });
    await limitado.api.responder(limitado.entrada);
    assert.equal(limitado.envios.length, 0);
    assert.match(limitado.entrada.errorBot, /límite mensual/);
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
