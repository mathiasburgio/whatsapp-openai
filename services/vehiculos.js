function disponible() { return process.env.VEHICULOS_API_HABILITADA === 'true'; }
async function buscar(filtro) {
    if (!disponible()) return { estado: 'sin_configurar', vehiculos: [] };
    const url = new URL(process.env.VEHICULOS_API_URL || 'https://rpsbikes.com.ar/buscar');
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL del catálogo inválida.');
    for (const campo of ['marca', 'modelo', 'estado', 'precioMinimo', 'precioMaximo']) {
        if (filtro[campo] !== null && filtro[campo] !== undefined) url.searchParams.set(campo, String(filtro[campo]));
    }
    const headers = { Accept: 'application/json' };
    if (process.env.VEHICULOS_API_TOKEN) headers.Authorization = 'Bearer ' + process.env.VEHICULOS_API_TOKEN;
    const respuesta = await fetch(url, { headers, signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!respuesta.ok) throw new Error('No se pudo consultar el catálogo: HTTP ' + respuesta.status);
    let bytes = 0;
    const partes = [];
    for await (const parte of respuesta.body) {
        bytes += parte.length;
        if (bytes > 1_000_000) throw new Error('El catálogo devolvió demasiada información.');
        partes.push(Buffer.from(parte));
    }
    const datos = JSON.parse(Buffer.concat(partes).toString('utf8'));
    const vehiculos = Array.isArray(datos) ? datos : datos?.vehiculos;
    if (!Array.isArray(vehiculos) || vehiculos.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('Respuesta del catálogo inválida: se esperaba un array o { vehiculos: [] }.');
    // Proyecta los datos comerciales sin pasar campos internos o credenciales al modelo.
    const resultados = vehiculos.slice(0, 8).map(vehiculo => Object.fromEntries(
        ['id', '_id', 'marca', 'modelo', 'anio', 'version', 'estado', 'precio', 'moneda', 'disponibilidad', 'stock', 'detalle', 'financiacion', 'url', 'enlace']
            .filter(campo => vehiculo[campo] !== undefined).map(campo => [campo, vehiculo[campo]])));
    if (JSON.stringify(resultados).length > 8000) throw new Error('Los datos del catálogo exceden el tamaño permitido para responder.');
    return { estado: resultados.length ? 'ok' : 'sin_resultados', consultadoEn: new Date().toISOString(), vehiculos: resultados };
}
module.exports = { disponible, buscar };
