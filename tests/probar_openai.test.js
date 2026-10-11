const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module } = require('node:module');

test('el script Decisions usa el ejemplo o un JSON personalizado e imprime uso y cierra MongoDB', async t => {
    const clave = process.env.OPENAI_API_KEY;
    const log = console.log;
    t.after(() => {
        console.log = log;
        if (clave === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = clave;
    });
    process.env.OPENAI_API_KEY = 'prueba';
    const salidas = [], lecturas = [], llamadas = [];
    let conexiones = 0, cierres = 0, fallar = false;
    console.log = valor => salidas.push(valor);
    const configuracion = { opciones: ['comprar', 'otro'], instrucciones: 'Clasificá.', nombre: 'intencion' };
    const esperado = { resultado: { type: 'choice', choice: 'comprar', confidence: 0.9 }, tokensGastados: { total: 42 } };
    const mocks = {
        dotenv: { config() {} },
        'node:fs/promises': { readFile: async archivo => { lecturas.push(archivo); return JSON.stringify(configuracion); } },
        '../services/mongo': { connectDB: async () => { conexiones++; }, disconnectDB: async () => { cierres++; } },
        '../services/openai': { procesarDecision: async (...args) => {
            llamadas.push(args);
            if (fallar) throw new Error('Falló la API');
            return esperado;
        } },
    };
    const filename = path.resolve(__dirname, '../scripts/probar_openai.js');
    const modulo = new Module(filename);
    modulo.filename = filename;
    modulo.paths = Module._nodeModulePaths(path.dirname(filename));
    modulo.require = nombre => Object.hasOwn(mocks, nombre) ? mocks[nombre] : require(nombre);
    modulo._compile(fs.readFileSync(filename, 'utf8'), filename);
    await modulo.exports.main(['decisions']);
    assert.equal(lecturas[0], path.resolve(__dirname, '../scripts/decisions-example.json'));
    assert.match(llamadas[0][0], /moto/);
    assert.equal(await modulo.exports.main(['decisions', 'Necesito repuestos', 'personalizado.json']), esperado);
    assert.equal(lecturas[1], 'personalizado.json');
    assert.deepEqual(llamadas[1], ['Necesito repuestos', configuracion.opciones, { instrucciones: 'Clasificá.', nombre: 'intencion' }]);
    assert.deepEqual(JSON.parse(salidas[1]), esperado);
    fallar = true;
    await assert.rejects(modulo.exports.main(['decisions']), /Falló la API/);
    assert.equal(conexiones, 3);
    assert.equal(cierres, 3);
    await modulo.exports.main(['decisions', '--help']);
    assert.match(salidas.at(-1), /probar_decisions/);
    assert.equal(conexiones, 3);
});
