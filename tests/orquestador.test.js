const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const Conversacion = require('../models/conversacion');
const Mensaje = require('../models/mensaje');

function preparar(t, servicios = {}) {
    const conversaciones = [], mensajes = [], cambios = [], logs = [], errores = [], archivos = [];
    t.mock.method(console, 'log', (...args) => logs.push(args));
    t.mock.method(console, 'error', (...args) => errores.push(args));
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
            updateOne: async ({ _id }, update) => {
                const doc = conversaciones.find(item => String(item._id) === String(_id));
                for (const [campo, valor] of Object.entries(update.$inc || {})) doc.set(campo, (doc.get(campo) || 0) + valor);
                for (const [campo, valor] of Object.entries(update.$set || {})) doc.set(campo, valor);
            },
            findOneAndUpdate: async (query, update) => {
                const doc = conversaciones.find(item => String(item._id) === String(query._id));
                if (query.$or && doc.ultimoMensaje?.fechaEmitida && new Date(doc.ultimoMensaje.fechaEmitida) > query.$or[1]['ultimoMensaje.fechaEmitida'].$lte) return null;
                for (const [campo, valor] of Object.entries(update.$set)) doc.set(campo, valor);
                for (const [campo, valor] of Object.entries(update.$inc || {})) doc.set(campo, (doc.get(campo) || 0) + valor);
                return doc;
            },
        },
        '../models/mensaje': {
            findOne: query => query.whatsappId ? Promise.resolve(mensajes.find(item => item.whatsappId === query.whatsappId))
                : { sort: async () => [...mensajes].reverse().find(item => String(item.conversacionId) === String(query.conversacionId) && item.deClienteParaSistema) },
            create: datos => persistir(new Mensaje(datos), mensajes),
        },
        './sockets': { notificarCambios: async (conversacion, mensaje) => {
            cambios.push({ conversacion: conversacion.toObject(), mensaje: mensaje.toObject() });
        } },
        './whatsapp': servicios.whatsapp || { obtenerMediaDesdeWhatsapp: async () => assert.fail('El texto no descarga archivos') },
        'node:fs/promises': {
            mkdir: async () => {},
            writeFile: async (ruta, buffer, opciones) => { archivos.push({ ruta, buffer, opciones }); },
        },
        './openai': servicios.openai || { procesarImagen: async () => assert.fail('El texto no consume OpenAI'),
            transcribirAudio: async () => assert.fail('El texto no consume OpenAI') },
        './bot': servicios.bot || { encolar: mensaje => { assert.equal(mensaje.estadoBot, 'omitido'); }, cancelarEspera: async () => {} },
        './prompts': { cargar: async () => ({ imagen: 'Describí con incertidumbre.', audio: 'Transcribí motos.' }) },
        './envios': {
            serializar: require('../services/envios').serializar,
            verificarLimiteMensual: async () => {
                const cantidad = mensajes.filter(item => item.deSistemaParaCliente && item.whatsappId).length;
                if (cantidad >= (servicios.limite ?? 2000)) throw new Error('Se alcanzó el límite mensual de respuestas de WhatsApp.');
            },
        },
    };
    const filename = path.resolve(__dirname, '../services/orquestador.js');
    const modulo = new Module(filename);
    modulo.filename = filename;
    modulo.paths = Module._nodeModulePaths(path.dirname(filename));
    const original = createRequire(filename);
    modulo.require = nombre => Object.hasOwn(mocks, nombre) ? mocks[nombre] : original(nombre);
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    return { api: modulo.exports, conversaciones, mensajes, cambios, logs, errores, archivos };
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
    assert.equal(conversaciones[0].nombre, 'Cliente');
    assert.equal(conversaciones[0].ultimoMensaje.contenido, 'Hola');
    assert.deepEqual(logs.at(-1)[0], { mensaje: 'Hola', respuestaOpenAi: null });
    assert.equal(cambios.at(-1).mensaje.contenido, 'Hola');
    await api.recibirMensajeWhatsapp('5491112345678', 'Otro mensaje', undefined, undefined, { ...datos, whatsappId: 'wamid.2' });
    assert.equal(conversaciones.length, 1);
    assert.equal(mensajes.length, 2);
    assert.equal(conversaciones[0].ultimoMensaje.contenido, 'Otro mensaje');
    assert.equal(typeof api.responderMensajePorApiWhataspp, 'function');
});

test('imágenes y audios se descargan y enriquecen el mensaje y suman tokens de conversación', async t => {
    const descargas = [], llamadas = [];
    const { api, conversaciones, mensajes, cambios, logs, archivos } = preparar(t, {
        whatsapp: { obtenerMediaDesdeWhatsapp: async (id, opciones) => {
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
    assert.equal(String(llamadas[0][2].mensajeId), String(imagen.mensaje._id));
    assert.equal(llamadas[0][2].instrucciones, 'Describí con incertidumbre.');
    assert.equal(imagen.mensaje.transcripcionImagen, 'Una Honda Navi');
    assert.equal(imagen.mensaje.contenido, 'Identificá esta moto\nUna Honda Navi');
    assert.equal(imagen.mensaje.contenidoOriginal, 'Identificá esta moto');
    assert.match(imagen.mensaje.imagenArchivo, /^[a-f0-9-]+\.jpg$/);
    assert.equal(path.basename(archivos[0].ruta), imagen.mensaje.imagenArchivo);
    assert.equal(path.basename(path.dirname(archivos[0].ruta)), 'imagenes');
    assert.deepEqual(archivos[0].buffer, Buffer.from('imagen'));
    assert.deepEqual(archivos[0].opciones, { flag: 'wx' });
    assert.equal(imagen.mensaje.esImagen, true);
    assert.equal(imagen.mensaje.usoLLM, true);
    assert.equal(imagen.mensaje.tokens.total, 25);
    await api.recibirMensajeWhatsapp(telefono, '', undefined, { id: 'audio' }, { whatsappId: 'wamid.audio', phoneNumberId: 'numero-1' });
    assert.deepEqual(llamadas[1][0], Buffer.from('audio'));
    assert.equal(llamadas[1][1], 'audio/ogg');
    assert.equal(llamadas[1][2].prompt, 'Transcribí motos.');
    assert.equal(String(llamadas[1][2].mensajeId), String(mensajes[1]._id));
    assert.equal(mensajes[1].esAudio, true);
    assert.match(mensajes[1].audioArchivo, /^[a-f0-9-]+\.ogg$/);
    assert.equal(path.basename(archivos[1].ruta), mensajes[1].audioArchivo);
    assert.equal(path.basename(path.dirname(archivos[1].ruta)), 'audio');
    assert.equal(mensajes[1].transcripcionAudio, 'Quiero comprarla');
    assert.equal(mensajes[1].contenido, 'Quiero comprarla');
    assert.equal(conversaciones[0].tokens.total, 38);
    assert.equal(conversaciones[0].tokens.entrada, 30);
    assert.equal(conversaciones[0].tokens.salida, 8);
    assert.equal(descargas[0].opciones.phoneNumberId, 'numero-1');
    assert.equal(descargas[0].opciones.maxBytes, 5000000);
    assert.equal(descargas[1].opciones.maxBytes, 15000000);
    assert.equal(cambios[0].mensaje.contenido, 'Identificá esta moto');
    assert.equal(cambios.at(-1).conversacion.ultimoMensaje.transcripcionAudio, 'Quiero comprarla');
    assert.deepEqual(logs.at(-1)[0], { mensaje: 'Quiero comprarla', respuestaOpenAi: 'Quiero comprarla' });
});

test('reintentos concurrentes no duplican mensajes, conversación ni consumo de OpenAI', async t => {
    let consultas = 0;
    const { api, conversaciones, mensajes } = preparar(t, {
        whatsapp: { obtenerMediaDesdeWhatsapp: async () => ({ buffer: Buffer.from('imagen'), mimeType: 'image/png' }) },
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

test('los mensajes se guardan y publican antes de encolarse; un duplicado no reinicia la espera', async t => {
    const encolados = [];
    const { api, conversaciones, mensajes, cambios } = preparar(t, {
        bot: { encolar: mensaje => {
            assert(mensajes.includes(mensaje));
            assert(cambios.some(item => String(item.mensaje._id) === String(mensaje._id)));
            if (mensaje.estadoBot === 'pendiente') encolados.push(mensaje);
        } },
    });
    const telefono = '5491112345678';
    await api.recibirMensajeWhatsapp(telefono, 'Antes de activar', undefined, undefined, { whatsappId: 'previo' });
    conversaciones[0].botActivo = true;
    for (const [id, texto] of [['uno', 'Hola tenés moto Corven'], ['dos', 'Qué precio'], ['tres', 'Sale patentada?']]) {
        await api.recibirMensajeWhatsapp(telefono, texto, undefined, undefined, { whatsappId: id });
    }
    await api.recibirMensajeWhatsapp(telefono, 'Qué precio', undefined, undefined, { whatsappId: 'dos' });
    assert.deepEqual(encolados.map(item => item.contenidoOriginal), ['Hola tenés moto Corven', 'Qué precio', 'Sale patentada?']);
    assert.equal(mensajes.length, 4);
});

test('un fallo de OpenAI conserva el mensaje, se registra en consola y no se reprocesa', async t => {
    let intentos = 0;
    const { api, conversaciones, mensajes, errores } = preparar(t, {
        whatsapp: { obtenerMediaDesdeWhatsapp: async () => ({ buffer: Buffer.from('audio'), mimeType: 'audio/ogg' }) },
        openai: { transcribirAudio: async () => {
            if (++intentos === 1) throw new Error('Cupo agotado');
            return { resultado: 'Hola desde audio', tokensGastados: { total: 10 } };
        } },
    });
    const recibir = () => api.recibirMensajeWhatsapp('5491112345678', '', undefined, { id: 'audio' }, { whatsappId: 'wamid.audio' });
    await recibir();
    assert.equal(mensajes.length, 1);
    assert.equal(mensajes[0].estadoBot, 'omitido');
    assert.match(mensajes[0].audioArchivo, /^[a-f0-9-]+\.ogg$/);
    assert.equal(mensajes[0].contenido, '[Audio]');
    assert.match(String(errores[0][1]), /Cupo agotado/);
    assert.equal((await recibir()).duplicado, true);
    assert.equal(mensajes.length, 1);
    assert.equal(intentos, 1);
    assert.equal(conversaciones[0].tokens.total ?? 0, 0);
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

test('un archivo no descargable conserva el mensaje e informa el error en consola', async t => {
    const { api, mensajes, conversaciones, errores } = preparar(t, {
        whatsapp: { obtenerMediaDesdeWhatsapp: async () => { throw new Error('Archivo vencido'); } },
    });
    await api.recibirMensajeWhatsapp('5491112345678', 'Mi moto', { id: 'imagen' }, undefined,
        { whatsappId: 'wamid.archivo' });
    assert.equal(mensajes[0].contenido, 'Mi moto');
    assert.equal(mensajes[0].estadoBot, 'omitido');
    assert.equal(mensajes[0].usoLLM, false);
    assert.equal(conversaciones[0].ultimoMensaje.contenido, 'Mi moto');
    assert.match(String(errores[0][1]), /Archivo vencido/);
});

test('un formato de imagen no admitido no se escribe ni se vincula al mensaje', async t => {
    const { api, mensajes, archivos, errores } = preparar(t, {
        whatsapp: { obtenerMediaDesdeWhatsapp: async () => ({ buffer: Buffer.from('<svg/>'), mimeType: 'image/svg+xml' }) },
    });
    await api.recibirMensajeWhatsapp('5491112345678', '', { id: 'imagen' }, undefined, { whatsappId: 'wamid.svg' });
    assert.equal(archivos.length, 0);
    assert.equal(mensajes[0].imagenArchivo, undefined);
    assert.match(String(errores[0][1]), /formato no compatible/);
});

test('una respuesta manual se integra mientras una imagen está en proceso y no queda reemplazada al terminar', async t => {
    let liberarImagen, imagenEnProceso;
    const inicio = new Promise(resolve => { imagenEnProceso = resolve; });
    const analisis = new Promise(resolve => { liberarImagen = resolve; });
    let envios = 0;
    const { api, conversaciones, mensajes } = preparar(t, {
        bot: { encolar: () => {}, cancelarEspera: async id => { assert.equal(id, String(conversaciones[0]._id)); assert.equal(conversaciones[0].botActivo, false); } },
        whatsapp: {
            obtenerMediaDesdeWhatsapp: async () => ({ buffer: Buffer.from('imagen'), mimeType: 'image/jpeg' }),
            enviarMensaje: async datos => { envios++; assert.equal(datos.phoneNumberId, 'numero-test'); return { messages: [{ id: 'wamid.vendedor' }] }; },
        },
        openai: { procesarImagen: async () => { imagenEnProceso(); await analisis; return { resultado: 'Una moto', tokensGastados: { total: 5 } }; } },
    });
    const recepcion = api.recibirMensajeWhatsapp('5491112345678', 'Quiero esta', { id: 'imagen' }, undefined,
        { whatsappId: 'wamid.imagen', phoneNumberId: 'numero-test', receptor: '5491198765432', fechaEmitida: new Date('2026-01-01') });
    await inicio;
    conversaciones[0].requiereAtencion = true;
    const enviada = await api.responderMensajePorApiWhataspp(String(conversaciones[0]._id), 'Hola, soy el vendedor.');
    assert(enviada.fechaEmitida instanceof Date);
    assert.equal(enviada.respuestaAutomatica, false);
    assert.equal(conversaciones[0].requiereAtencion, false);
    liberarImagen();
    await recepcion;
    assert.equal(conversaciones[0].ultimoMensaje.whatsappId, 'wamid.vendedor');
    assert.equal(conversaciones[0].tokens.total, 5);
    assert.equal(mensajes.length, 2);
    assert.equal(envios, 1);
});

test('un envío manual sin confirmación no crea mensaje y deja la conversación pendiente', async t => {
    let envios = 0;
    const { api, conversaciones, mensajes, errores } = preparar(t, { whatsapp: { enviarMensaje: async () => {
        envios++; throw envios === 1 ? Object.assign(new Error('Fuera de la ventana de atención'), { status: 400 }) : new Error('Tiempo agotado');
    } } });
    await api.recibirMensajeWhatsapp('5491112345678', 'Hola', undefined, undefined, { whatsappId: 'wamid.in' });
    const id = String(conversaciones[0]._id);
    await assert.rejects(api.responderMensajePorApiWhataspp(id, 'Respuesta'), /Fuera de la ventana/);
    assert.equal(conversaciones[0].ultimoMensaje.whatsappId, 'wamid.in');
    assert.equal(conversaciones[0].requiereAtencion, true);
    await assert.rejects(api.responderMensajePorApiWhataspp(id, 'Respuesta'), /Tiempo agotado/);
    assert.equal(envios, 2);
    assert.equal(mensajes.length, 1);
    assert.equal(errores.length, 2);
});

test('el envío manual se bloquea cuando se agotó el cupo de WhatsApp', async t => {
    let llamadasWhatsapp = 0;
    const { api, conversaciones, mensajes } = preparar(t, { limite: 0, whatsapp: {
        enviarMensaje: async () => { llamadasWhatsapp++; return { messages: [{ id: 'wamid.no-debe-enviarse' }] }; },
    } });
    await api.recibirMensajeWhatsapp('5491112345678', 'Hola', undefined, undefined, { whatsappId: 'wamid.entrada' });
    await assert.rejects(api.responderMensajePorApiWhataspp(String(conversaciones[0]._id), 'Respuesta'), /límite mensual/);
    assert.equal(llamadasWhatsapp, 0);
    assert.equal(mensajes.length, 1);
    assert.equal(conversaciones[0].requiereAtencion, true);
});
