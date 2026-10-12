const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');

function cargar(filename, mocks, fuente = fs.readFileSync(filename, 'utf8')) {
    const modulo = new Module(filename);
    const original = createRequire(filename);
    modulo.require = nombre => Object.hasOwn(mocks, nombre) ? mocks[nombre] : original(nombre);
    modulo._compile(fuente, filename);
    return modulo.exports;
}

test('métricas usa el mes UTC completo, excluye rechazos y cuenta solo respuestas automáticas aceptadas', async () => {
    let filtroUso, filtroMensajes;
    let registros = [{ llamadasWebSearch: 3, llamadasProcesarTexto: 8, segundosProcesados: 20, imagenesProcesadas: 2,
        tokensEntrada: 40, tokensSalida: 10, tokensProcesados: 50 }];
    const api = cargar(path.resolve(__dirname, '../services/metricas.js'), {
        '../models/uso': { aggregate: async pipeline => { filtroUso = pipeline[0].$match; return registros; } },
        '../models/mensaje': { countDocuments: async query => { filtroMensajes = query; return 4; } },
    });
    const metricas = await api.obtenerMetricasMensuales(new Date('2026-12-31T23:59:59.999Z'));
    assert.deepEqual(metricas.periodo, { inicio: '2026-12-01T00:00:00.000Z', fin: '2027-01-01T00:00:00.000Z', zonaHoraria: 'UTC' });
    assert.equal(filtroUso.servicio, 'openai');
    assert.deepEqual(filtroUso.estado, { $ne: 'rechazado' });
    assert.equal(filtroUso.createdAt.$gte.toISOString(), metricas.periodo.inicio);
    assert.equal(filtroUso.createdAt.$lt.toISOString(), metricas.periodo.fin);
    assert.equal(filtroMensajes.respuestaAutomatica, true);
    assert.equal(filtroMensajes.deSistemaParaCliente, true);
    assert.deepEqual(filtroMensajes.whatsappId, { $type: 'string' });
    assert.deepEqual(filtroMensajes.fechaEmitida, filtroUso.createdAt);
    assert.equal(metricas.tokensProcesados, 50);
    assert.equal(metricas.respuestasAutomaticas, 4);
    registros = [];
    const vacias = await api.obtenerMetricasMensuales(new Date('2026-01-01T00:00:00Z'));
    for (const campo of ['llamadasWebSearch', 'llamadasProcesarTexto', 'segundosProcesados', 'imagenesProcesadas', 'tokensEntrada', 'tokensSalida', 'tokensProcesados']) assert.equal(vacias[campo], 0);
});

test('el panel protege métricas y control de bot, valida booleanos y notifica los cambios persistidos', async t => {
    const id = '507f1f77bcf86cd799439011';
    let cambios = 0, consultas = 0, lecturaMetricas = 0;
    const periodosConsultados = [];
    const conversacion = { _id: id, botActivo: false, telefono: '5491112345678' };
    const prompt = { id: 'respuesta', contenido: 'Respondé breve.', version: 'a'.repeat(64) };
    const filename = path.resolve(__dirname, '../index.js');
    const app = cargar(filename, {
        dotenv: { config() {} },
        './services/orquestador': {}, './services/mongo': {},
        './services/whatsapp': { configurarWebhook() {}, recibirMensajeWebhook() {} },
        './services/usuarios': { iniciarSesion() {}, cerrarSesion() {} },
        './services/sockets': { inicializar() {}, notificarCambios: async actual => { cambios++; assert.equal(actual, conversacion); } },
        './services/metricas': { obtenerMetricasMensuales: async fecha => {
            lecturaMetricas++;
            periodosConsultados.push(fecha);
            return { llamadasWebSearch: 2, respuestasAutomaticas: 0 };
        } },
        './services/prompts': { listar: async () => [prompt], guardar: async (id, contenido, version) => {
            if (id !== prompt.id) throw Object.assign(new Error('Prompt no encontrado.'), { status: 404 });
            if (!contenido) throw Object.assign(new Error('Contenido inválido.'), { status: 400 });
            if (version !== prompt.version) throw Object.assign(new Error('El prompt cambió.'), { status: 409 });
            Object.assign(prompt, { contenido, version: 'b'.repeat(64) }); return prompt;
        } },
        './models/usuarios': { exists: async ({ _id }) => _id === 'activo' },
        './middlewares/tieneSesion': async (req, res, next) => {
            if (req.session.usuarioId !== 'activo') return res.status(401).json({ error: 'Iniciá sesión para continuar.' });
            next();
        },
        './middlewares/middlewareSession': (req, res, next) => { req.session = { usuarioId: req.headers['x-test-usuario'] }; next(); },
        './models/conversacion': { findOneAndUpdate: async (query, update, opciones) => {
            consultas++;
            assert.equal(opciones.returnDocument, 'after');
            assert.equal(opciones.runValidators, true);
            assert.equal(typeof update.$set.botActivo, 'boolean');
            assert.deepEqual(Object.keys(update.$set), ['botActivo']);
            assert.equal(update.$inc, undefined);
            if (query._id !== id) return null;
            conversacion.botActivo = update.$set.botActivo;
            return conversacion;
        } },
    }, fs.readFileSync(filename, 'utf8').replace(/^iniciar\(\);\s*$/m, 'module.exports = app;'));
    const servidor = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { servidor.once('listening', resolve); servidor.once('error', reject); });
    t.after(() => new Promise(resolve => servidor.close(resolve)));
    const base = `http://127.0.0.1:${servidor.address().port}`;
    async function pedir(ruta, body, usuario = 'activo', metodo = body === undefined ? 'GET' : 'POST') {
        const respuesta = await fetch(base + ruta, { method: metodo,
            headers: { 'Content-Type': 'application/json', ...(usuario ? { 'x-test-usuario': usuario } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
        return { status: respuesta.status, headers: respuesta.headers, body: await respuesta.json() };
    }
    for (const usuario of [null, 'deshabilitado']) {
        assert.equal((await pedir('/metricas/mes', undefined, usuario)).status, 401);
        assert.equal((await pedir('/conversaciones/habilitar-bot', { conversacionId: id }, usuario)).status, 401);
        assert.equal((await pedir('/conversaciones/deshabilitar-bot', { conversacionId: id }, usuario)).status, 401);
        assert.equal((await pedir('/prompts/obtener', undefined, usuario)).status, 401);
        assert.equal((await pedir('/prompts/guardar', { id: 'respuesta', contenido: 'Cambio' }, usuario)).status, 401);
    }
    assert.equal((await pedir('/sesion/activa', undefined, null)).body, false);
    assert.equal(consultas, 0); assert.equal(lecturaMetricas, 0);
    assert.equal((await pedir('/conversaciones/habilitar-bot', { conversacionId: 'invalido' })).status, 400);
    assert.equal((await pedir('/conversaciones/deshabilitar-bot', {})).status, 400);
    assert.equal(consultas, 0);
    const activada = await pedir('/conversaciones/habilitar-bot', { conversacionId: id, botActivo: false, telefono: 'ignorado' });
    assert.equal(activada.status, 200);
    assert.equal(activada.body.botActivo, true);
    assert.equal(activada.body.telefono, '5491112345678');
    assert.equal((await pedir('/conversaciones/deshabilitar-bot', { conversacionId: id, botActivo: true })).body.botActivo, false);
    assert.equal(cambios, 2);
    assert.equal((await pedir('/conversaciones/habilitar-bot', { conversacionId: '507f1f77bcf86cd799439099' })).status, 404);
    assert.equal((await pedir('/conversaciones/deshabilitar-bot', { conversacionId: '507f1f77bcf86cd799439099' })).status, 404);
    assert.equal(cambios, 2);
    const metricas = await pedir('/metricas/mes');
    assert.equal(metricas.status, 200);
    assert.equal(metricas.headers.get('cache-control'), 'no-store');
    assert.deepEqual(metricas.body, { llamadasWebSearch: 2, respuestasAutomaticas: 0 });
    const actual = new Date();
    assert.equal(periodosConsultados[0].getUTCFullYear(), actual.getUTCFullYear());
    assert.equal(periodosConsultados[0].getUTCMonth(), actual.getUTCMonth());
    assert.equal((await pedir('/metricas/mes?anio=2024&mes=2')).status, 200);
    assert.equal(periodosConsultados[1].toISOString(), '2024-02-01T00:00:00.000Z');
    assert.equal((await pedir('/metricas/mes?anio=2024')).status, 200);
    assert.equal(periodosConsultados[2].getUTCFullYear(), 2024);
    assert.equal(periodosConsultados[2].getUTCMonth(), actual.getUTCMonth());
    assert.equal((await pedir('/metricas/mes?mes=2')).status, 200);
    assert.equal(periodosConsultados[3].getUTCFullYear(), actual.getUTCFullYear());
    assert.equal(periodosConsultados[3].getUTCMonth(), 1);
    for (const ruta of ['/metricas/mes?anio=0', '/metricas/mes?anio=2024x', '/metricas/mes?mes=0',
        '/metricas/mes?mes=13', '/metricas/mes?mes=2&mes=3']) {
        assert.equal((await pedir(ruta)).status, 400);
    }
    assert.equal(lecturaMetricas, 4);
    const listado = await pedir('/prompts/obtener');
    assert.equal(listado.status, 200);
    assert.equal(listado.headers.get('cache-control'), 'no-store');
    assert.equal(listado.body[0].contenido, 'Respondé breve.');
    assert.equal((await pedir('/prompts/guardar', { id: 'desconocido', contenido: 'Cambio' })).status, 404);
    assert.equal((await pedir('/prompts/guardar', { id: 'respuesta', contenido: '' })).status, 400);
    assert.equal((await pedir('/prompts/guardar', { id: 'respuesta', contenido: 'Cambio', version: 'anterior' })).status, 409);
    assert.equal((await pedir('/prompts/guardar', { id: 'respuesta', contenido: 'Nueva regla', version: 'a'.repeat(64) })).body.contenido, 'Nueva regla');
    assert.equal((await pedir('/prompts/obtener')).body[0].contenido, 'Nueva regla');
});
