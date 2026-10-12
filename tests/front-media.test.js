const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('el panel separa el caption de las inferencias sin duplicar descripciones ni transcripciones antiguas', () => {
    const jquery = () => ({ on() {} });
    jquery.get = async () => false;
    const contexto = vm.createContext({ $: jquery, io: () => ({ on() {} }) });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/index.js'), 'utf8'), contexto);
    const original = vm.runInContext('textoOriginal', contexto);
    assert.equal(original({ contenidoOriginal: 'Mi moto', contenido: 'Mi moto\nUna moto', transcripcionImagen: 'Una moto' }), 'Mi moto');
    assert.equal(original({ esImagen: true, crudo: { image: { caption: '<script>caption</script>' } }, contenido: 'inferido' }), '<script>caption</script>');
    assert.equal(original({ esImagen: true, contenido: 'Mi moto\nUna moto', transcripcionImagen: 'Una moto' }), 'Mi moto');
    assert.equal(original({ esImagen: true, contenido: 'Una moto', transcripcionImagen: 'Una moto' }), '');
    assert.equal(original({ esAudio: true, contenido: 'Quiero comprar', transcripcionAudio: 'Quiero comprar' }), '');
    assert.equal(original({ esAudio: true, contenido: '[Audio]' }), '');
    assert.equal(original({ contenido: 'Hola' }), 'Hola');
});
