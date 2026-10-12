// Coordina el envío manual y el automático dentro de este proceso.
let pendiente = Promise.resolve();
function serializar(operacion) {
    const actual = pendiente.catch(() => {}).then(operacion);
    pendiente = actual;
    return actual;
}
module.exports = { serializar };
