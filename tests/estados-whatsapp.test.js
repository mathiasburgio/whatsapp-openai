const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');

function cargar(mocks, filename = path.resolve(__dirname, '../services/whatsapp.js')) {
    const modulo = new Module(filename);
    const original = createRequire(filename);
    modulo.require = nombre => Object.hasOwn(mocks, nombre) ? mocks[nombre] : original(nombre);
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    return modulo.exports;
}

test('los avisos de WhatsApp actualizan fechas y avisan fallos de entrega', async t => {
    const errores = [];
    t.mock.method(console, 'error', (...datos) => errores.push(datos));
    const mensajes = [
        { _id: 'viejo', conversacionId: 'conversacion', whatsappId: 'wamid.viejo', deSistemaParaCliente: true },
        { _id: 'actual', conversacionId: 'conversacion', whatsappId: 'wamid.actual', deSistemaParaCliente: true },
        { _id: 'fallido', conversacionId: 'conversacion', whatsappId: 'wamid.fallido', deSistemaParaCliente: true },
    ];
    const conversacion = { _id: 'conversacion', botActivo: true, ultimoMensaje: { _id: 'actual' }, accionesExternasRequeridas: [] };
    const notificados = [];
    const mocks = {
        './orquestador': {},
        '../models/mensaje': { findOne: async filtro => mensajes.find(item => item.whatsappId === filtro.whatsappId && item.deSistemaParaCliente),
            findOneAndUpdate: async (filtro, actualizacion) => {
            const mensaje = mensajes.find(item => item.whatsappId === filtro.whatsappId && item.deSistemaParaCliente);
            if (!mensaje ||
                (Object.hasOwn(filtro, 'fechaEntregada') && mensaje.fechaEntregada) ||
                (Object.hasOwn(filtro, 'fechaLeida') && mensaje.fechaLeida)) return null;
            Object.assign(mensaje, actualizacion.$set);
            return { ...mensaje };
        } },
        '../models/conversacion': {
            findOneAndUpdate: async (filtro, actualizacion) => {
                const distinto = filtro['accionesExternasRequeridas._id']?.$ne;
                if (distinto && conversacion.accionesExternasRequeridas.some(item => item._id === distinto)) return null;
                if (filtro['ultimoMensaje._id']) {
                    if (filtro['ultimoMensaje._id'] !== conversacion.ultimoMensaje._id) return null;
                    for (const [clave, valor] of Object.entries(actualizacion.$set)) conversacion.ultimoMensaje[clave.slice('ultimoMensaje.'.length)] = valor;
                } else Object.assign(conversacion, actualizacion.$set || {});
                if (actualizacion.$push) conversacion.accionesExternasRequeridas.push(actualizacion.$push.accionesExternasRequeridas);
                return structuredClone(conversacion);
            },
            findById: async () => structuredClone(conversacion),
        },
        './sockets': { notificarCambios: async (actual, mensaje) => notificados.push({ actual, mensaje }) },
    };
    mocks['./accionesExternas'] = cargar(mocks, path.resolve(__dirname, '../services/accionesExternas.js'));
    const registrar = cargar(mocks).registrarEstado;

    const lectura = { id: 'wamid.actual', status: 'read', timestamp: '1700000002' };
    assert.equal(await registrar(lectura), true);
    assert.equal(mensajes[1].fechaLeida.toISOString(), '2023-11-14T22:13:22.000Z');
    assert.equal(conversacion.ultimoMensaje.fechaLeida.toISOString(), mensajes[1].fechaLeida.toISOString());
    assert.equal(await registrar(lectura), false);
    assert.equal(await registrar({ id: 'wamid.actual', status: 'delivered', timestamp: '1700000001' }), true);
    assert.equal(mensajes[1].fechaEntregada.toISOString(), '2023-11-14T22:13:21.000Z');
    assert.equal(conversacion.ultimoMensaje.fechaLeida.toISOString(), mensajes[1].fechaLeida.toISOString());
    assert.equal(await registrar({ id: 'wamid.viejo', status: 'delivered', timestamp: '1700000001' }), true);
    assert.equal(conversacion.ultimoMensaje._id, 'actual');
    assert.equal(conversacion.ultimoMensaje.fechaEntregada.toISOString(), mensajes[1].fechaEntregada.toISOString());

    const fallo = { id: 'wamid.fallido', status: 'failed', timestamp: '1700000003', errors: [{ message: 'Destinatario no disponible' }] };
    assert.equal(await registrar(fallo), true);
    assert.equal(conversacion.accionesExternasRequeridas.length, 1);
    assert.equal(conversacion.botActivo, true);
    assert.equal(conversacion.accionesExternasRequeridas[0].detalle, 'Destinatario no disponible');
    assert.equal(errores.length, 1);
    assert.equal(await registrar({ id: 'desconocido', status: 'read', timestamp: '1700000004' }), false);
    assert.equal(await registrar({ id: 'wamid.actual', status: 'sent', timestamp: '1700000004' }), false);
    assert.equal(await registrar({ id: 'wamid.actual', status: 'read', timestamp: 'invalido' }), false);
    assert.equal(notificados.length, 4);
    assert.equal(notificados[0].mensaje._id, 'actual');
    assert.equal(notificados[2].mensaje._id, 'viejo');
    assert.equal(notificados[2].actual.ultimoMensaje._id, 'actual');
    assert.equal(await registrar(fallo), true);
    assert.equal(conversacion.accionesExternasRequeridas.length, 1);
    assert.equal(conversacion.botActivo, true);
    conversacion.botActivo = false;
    assert.equal(await registrar(fallo), true);
    assert.equal(conversacion.botActivo, false);
});
