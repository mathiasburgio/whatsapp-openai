const test = require('node:test');
const assert = require('node:assert/strict');
const vehiculos = require('../services/vehiculos');
test('catálogo desactivado no consulta; activado envía filtros y proyecta solo datos comerciales', async t => {
    const entorno = ['VEHICULOS_API_HABILITADA', 'VEHICULOS_API_URL', 'VEHICULOS_API_TOKEN'].map(nombre => [nombre, process.env[nombre]]);
    t.after(() => entorno.forEach(([nombre, valor]) => { if (valor === undefined) delete process.env[nombre]; else process.env[nombre] = valor; }));
    let consultas = 0;
    let esperados = { marca: 'Corven', modelo: 'XXX', precioMinimo: '0', precioMaximo: '100' };
    t.mock.method(global, 'fetch', async (url, opciones) => {
        consultas++;
        assert.equal(url.origin + url.pathname, 'https://rpsbikes.com.ar/buscar');
        assert.deepEqual(Object.fromEntries(url.searchParams), esperados);
        assert.equal(opciones.headers.Authorization, 'Bearer prueba');
        return new Response(JSON.stringify({ vehiculos: [{ marca: 'Corven', modelo: 'XXX', vehiculo: 'moto', tipo: 'urbana', estado: 'usado', detalle: 'Muy buen estado', color: 'Rojo', disponible: true, enlace: 'https://rpsbikes.com.ar/moto/corven', precio: 100, moneda: 'ARS', credencial: 'secreto' }] }));
    });
    process.env.VEHICULOS_API_HABILITADA = 'false';
    const filtro = { marca: 'Corven', modelo: 'XXX', precioMinimo: 0, precioMaximo: 100,
        vehiculo: 'moto', tipo: 'urbana', estado: 'nuevo', color: 'rojo', privado: 'ignorado' };
    assert.equal((await vehiculos.buscar(filtro)).estado, 'sin_configurar');
    assert.equal(consultas, 0);
    process.env.VEHICULOS_API_HABILITADA = 'true';
    process.env.VEHICULOS_API_URL = 'https://rpsbikes.com.ar/buscar?estado=nuevo&color=blanco&vehiculo=moto&tipo=urbana&precioMinimo=10&precioMaximo=20&marca=Honda&privado=ignorado';
    process.env.VEHICULOS_API_TOKEN = 'prueba';
    const resultado = await vehiculos.buscar(filtro);
    assert.equal(resultado.estado, 'ok');
    assert.equal(resultado.vehiculos[0].credencial, undefined);
    assert.equal(resultado.vehiculos[0].precio, 100);
    assert.equal(resultado.vehiculos[0].vehiculo, 'moto');
    assert.equal(resultado.vehiculos[0].tipo, 'urbana');
    assert.equal(resultado.vehiculos[0].color, 'Rojo');
    assert.equal(resultado.vehiculos[0].estado, 'usado');
    assert.equal(resultado.vehiculos[0].detalle, 'Muy buen estado');
    assert.equal(resultado.vehiculos[0].disponible, true);
    assert.equal(resultado.vehiculos[0].enlace, 'https://rpsbikes.com.ar/moto/corven');
    esperados = { marca: 'Corven', modelo: 'XXX' };
    await vehiculos.buscar({ marca: 'Corven', modelo: 'XXX', precioMinimo: null, precioMaximo: null });
    assert.equal(consultas, 2);
});
