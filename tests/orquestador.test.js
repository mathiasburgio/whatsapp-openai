const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');

function preparar(t, servicios = {}) {
    const conversaciones = [], mensajes = [], cambios = [], logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args));
    function persistir(documento, lista) {
        documento.save = async () => { await documento.validate(); return documento; };
        lista.push(documento);
        return documento.save();
    }
    const mocks = {
        '../models/conversacion': {
            findOne: ({ telefono }) => ({ sort: async () => conversaciones.find(item => item.telefono === telefono) }),
            findById: async id => conversaciones.find(item => String(item._id) === String(id)),
            create: datos => persistir(new Conversacion(datos), conversaciones),
        },
        '../models/mensaje': {
            findOne: async ({ whatsappId }) => mensajes.find(item => item.whatsappId === whatsappId),
            create: datos => persistir(new Mensaje(datos), mensajes),
        },
        './sockets': { notificarCambios: async (conversacion, mensaje) => {
            cambios.push({ conversacion: conversacion.toObject(), mensaje: mensaje.toObject() });
        } },
        './whatsapp': servicios.whatsapp || { descargarMedia: async () => assert.fail('El texto no descarga archivos') },
        './openai': servicios.openai || { procesarImagen: async () => assert.fail('El texto no consume OpenAI'),
            transcribirAudio: async () => assert.fail('El texto no consume OpenAI') },
    };
    const filename = path.resolve(__dirname, '../services/orquestador.js');
    const modulo = new Module(filename);
    modulo.filename = filename;
    modulo.paths = Module._nodeModulePaths(path.dirname(filename));
    const original = createRequire(filename);
    modulo.require = nombre => Object.hasOwn(mocks, nombre) ? mocks[nombre] : original(nombre);
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    return { api: modulo.exports, conversaciones, mensajes, cambios, logs };
}

test('la recepción crea o reutiliza conversación, persiste texto y lo muestra en consola y panel', async t => {
    const { api, conversaciones, mensajes, cambios, logs } = preparar(t);
    const crudo = { id: 'wamid.1', text: { body: 'Hola' } };
    const datos = { whatsappId: 'wamid.1', nombre: 'Cliente', receptor: '5491198765432', crudo,
        fechaEmitida: new Date('2026-01-01T10:00:00Z') };
    const recibido = await api.recibirMensajeWhatsapp('5491112345678', 'Hola', undefined, undefined, datos);
    assert.equal(conversaciones.length, 1);
    assert.equal(mensajes.length, 1);
    assert.equal(recibido.mensaje.conversacionId.toString(), conversaciones[0]._id.toString());
    assert.equal(recibido.mensaje.emisor, '5491112345678');
    assert.equal(recibido.mensaje.receptor, datos.receptor);
    assert.equal(recibido.mensaje.deClienteParaSistema, true);
    assert.equal(recibido.mensaje.deSistemaParaCliente, false);
    assert.deepEqual(recibido.mensaje.crudo, crudo);
    assert.equal(recibido.mensaje.usoLLM, false);
    assert.equal(recibido.mensaje.estadoProcesamiento, 'completado');
    assert.equal(conversaciones[0].nombre, 'Cliente');
    assert.equal(conversaciones[0].ultimoMensaje.contenido, 'Hola');
    assert.deepEqual(logs.at(-1)[0], { mensaje: 'Hola', respuestaOpenAi: null });
    assert.equal(cambios.at(-1).mensaje.estadoProcesamiento, 'completado');
    await api.recibirMensajeWhatsapp('5491112345678', 'Otro mensaje', undefined, undefined, { ...datos, whatsappId: 'wamid.2' });
    assert.equal(conversaciones.length, 1);
    assert.equal(mensajes.length, 2);
    assert.equal(conversaciones[0].ultimoMensaje.contenido, 'Otro mensaje');
    assert.equal(api.recibirMensajeVendedor, undefined);
});

test('imágenes y audios se descargan y enriquecen el mensaje y suman tokens de conversación', async t => {
    const descargas = [], llamadas = [];
    const { api, conversaciones, mensajes, cambios, logs } = preparar(t, {
        whatsapp: { descargarMedia: async (id, opciones) => {
            descargas.push({ id, opciones });
            return { buffer: Buffer.from(id), mimeType: id === 'imagen' ? 'image/jpeg' : 'audio/ogg' };
        } },
        openai: {
            procesarImagen: async (...args) => { llamadas.push(args); return { resultado: 'Una Honda Navi', tokensGastados: { entrada: 20, salida: 5, total: 25 } }; },
            transcribirAudio: async (...args) => { llamadas.push(args); return { resultado: 'Quiero comprarla', tokensGastados: { entrada: 10, salida: 3, total: 13 } }; },
        },
    });
    const telefono = '5491112345678';
    const imagen = await api.recibirMensajeWhatsapp(telefono, 'Identificá esta moto', { id: 'imagen' }, undefined,
        { whatsappId: 'wamid.imagen', phoneNumberId: 'numero-1' });
    assert.match(llamadas[0][0], /^data:image\/jpeg;base64,/);
    assert.equal(llamadas[0][1], 'Identificá esta moto');
    assert.equal(llamadas[0][2].conversacionId.toString(), imagen.conversacion._id.toString());
    assert.equal(imagen.mensaje.transcripcionImagen, 'Una Honda Navi');
    assert.equal(imagen.mensaje.contenido, 'Identificá esta moto\nUna Honda Navi');
    assert.equal(imagen.mensaje.esImagen, true);
    assert.equal(imagen.mensaje.usoLLM, true);
    assert.equal(imagen.mensaje.tokens.total, 25);
    await api.recibirMensajeWhatsapp(telefono, '', undefined, { id: 'audio' }, { whatsappId: 'wamid.audio', phoneNumberId: 'numero-1' });
    assert.deepEqual(llamadas[1][0], Buffer.from('audio'));
    assert.equal(llamadas[1][1], 'audio/ogg');
    assert.equal(mensajes[1].esAudio, true);
    assert.equal(mensajes[1].transcripcionAudio, 'Quiero comprarla');
    assert.equal(mensajes[1].contenido, 'Quiero comprarla');
    assert.equal(conversaciones[0].tokens.total, 38);
    assert.equal(conversaciones[0].tokens.entrada, 30);
    assert.equal(conversaciones[0].tokens.salida, 8);
    assert.equal(descargas[0].opciones.phoneNumberId, 'numero-1');
    assert.equal(descargas[0].opciones.maxBytes, 5000000);
    assert.equal(descargas[1].opciones.maxBytes, 15000000);
    assert.equal(cambios[0].mensaje.estadoProcesamiento, 'pendiente');
    assert.equal(cambios.at(-1).conversacion.ultimoMensaje.transcripcionAudio, 'Quiero comprarla');
    assert.deepEqual(logs.at(-1)[0], { mensaje: 'Quiero comprarla', respuestaOpenAi: 'Quiero comprarla' });
});

test('reintentos concurrentes no duplican mensajes, conversación ni consumo de OpenAI', async t => {
    let consultas = 0;
    const { api, conversaciones, mensajes } = preparar(t, {
        whatsapp: { descargarMedia: async () => ({ buffer: Buffer.from('imagen'), mimeType: 'image/png' }) },
        openai: { procesarImagen: async () => { consultas++; return { resultado: 'Una moto', tokensGastados: { total: 5 } }; } },
    });
    const resultados = await Promise.all([
        api.recibirMensajeWhatsapp('5491112345678', '', { id: 'imagen' }, undefined, { whatsappId: 'wamid.1' }),
        api.recibirMensajeWhatsapp('5491112345678', '', { id: 'imagen' }, undefined, { whatsappId: 'wamid.1' }),
        api.recibirMensajeWhatsapp('5491112345678', 'Hola', undefined, undefined, { whatsappId: 'wamid.2' }),
    ]);
    assert.equal(resultados[1].duplicado, true);
    assert.equal(conversaciones.length, 1);
    assert.equal(mensajes.length, 2);
    assert.equal(consultas, 1);
    assert.equal(conversaciones[0].tokens.total, 5);
    assert.equal(conversaciones[0].ultimoMensaje.contenido, 'Hola');
});

test('un fallo de OpenAI conserva el mensaje, informa al panel y permite reintentar', async t => {
    let intentos = 0;
    const { api, conversaciones, mensajes, cambios } = preparar(t, {
        whatsapp: { descargarMedia: async () => ({ buffer: Buffer.from('audio'), mimeType: 'audio/ogg' }) },
        openai: { transcribirAudio: async () => {
            if (++intentos === 1) throw new Error('Cupo agotado');
            return { resultado: 'Hola desde audio', tokensGastados: { total: 10 } };
        } },
    });
    const recibir = () => api.recibirMensajeWhatsapp('5491112345678', '', undefined, { id: 'audio' }, { whatsappId: 'wamid.audio' });
    await assert.rejects(recibir(), /Cupo agotado/);
    assert.equal(mensajes.length, 1);
    assert.equal(mensajes[0].estadoProcesamiento, 'fallido');
    assert.equal(mensajes[0].errorProcesamiento, 'Cupo agotado');
    assert.equal(mensajes[0].contenido, '[Audio]');
    assert.equal(cambios.at(-1).mensaje.estadoProcesamiento, 'fallido');
    await recibir();
    assert.equal(mensajes.length, 1);
    assert.equal(mensajes[0].estadoProcesamiento, 'completado');
    assert.equal(mensajes[0].errorProcesamiento, undefined);
    assert.equal(conversaciones[0].tokens.total, 10);
});

test('eventos antiguos no reemplazan el último mensaje y entradas inválidas no se guardan', async t => {
    const { api, conversaciones, mensajes } = preparar(t);
    await assert.rejects(api.recibirMensajeWhatsapp('invalido', 'Hola'), /teléfono/);
    await assert.rejects(api.recibirMensajeWhatsapp('5491112345678', {}), /texto/);
    assert.equal(mensajes.length, 0);
    await api.recibirMensajeWhatsapp('5491112345678', 'Nuevo', undefined, undefined, { whatsappId: 'nuevo', fechaEmitida: new Date('2026-02-02') });
    await api.recibirMensajeWhatsapp('5491112345678', 'Antiguo', undefined, undefined, { whatsappId: 'antiguo', fechaEmitida: new Date('2026-02-01') });
    assert.equal(mensajes.length, 2);
    assert.equal(conversaciones[0].ultimoMensaje.contenido, 'Nuevo');
});

test('un archivo no descargable conserva el mensaje sin consumir OpenAI', async t => {
    const { api, mensajes, conversaciones } = preparar(t, {
        whatsapp: { descargarMedia: async () => { throw new Error('Archivo vencido'); } },
    });
    await assert.rejects(api.recibirMensajeWhatsapp('5491112345678', 'Mi moto', { id: 'imagen' }, undefined,
        { whatsappId: 'wamid.archivo' }), /Archivo vencido/);
    assert.equal(mensajes[0].contenido, 'Mi moto');
    assert.equal(mensajes[0].estadoProcesamiento, 'fallido');
    assert.equal(mensajes[0].usoLLM, false);
    assert.equal(conversaciones[0].ultimoMensaje.errorProcesamiento, 'Archivo vencido');
});
