function disponible() { return process.env.VEHICULOS_API_HABILITADA === 'true'; }
async function buscar(filtro) {
    if (!disponible()) return { estado: 'sin_configurar', vehiculos: [] };
    if (typeof filtro?.marca !== 'string' || !filtro.marca.trim() || filtro.marca.length > 80) throw new Error('La búsqueda necesita una marca válida.');
    const url = new URL(process.env.VEHICULOS_API_URL || 'https://rpsbikes.com.ar/buscar');
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL del catálogo inválida.');
    // El catálogo se consulta solo por marca; el LLM compara las demás preferencias.
    url.search = '';
    url.searchParams.set('marca', filtro.marca.trim());
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
    // Proyecta los datos permitidos, incluidas las observaciones internas para redactar la respuesta.
    const resultados = vehiculos.map(vehiculo => Object.fromEntries(
        ['id', '_id', 'vehiculoId', 'marca', 'modelo', 'vehiculo', 'tipo', 'anio', 'version', 'estado', 'color', 'precio', 'moneda', 'disponible', 'detalle', 'observacionesInternas', 'financiacion', 'url', 'enlace',
            'kilometraje', 'cilindrada', 'combustible', 'transmision', 'marchas', 'potenciaHp', 'torqueNm', 'cilindros',
            'regrigeracion', 'refrigeracion', 'pesoKg', 'capacidadTanqueL', 'origen', 'visible', 'prioridad', 'descripcion']
            .filter(campo => vehiculo[campo] !== undefined).map(campo => [campo, vehiculo[campo]])));
    for (let i = 0; i < resultados.length; i++) {
        if (!Array.isArray(vehiculos[i].fotos)) continue;
        resultados[i].fotos = vehiculos[i].fotos.filter(foto => {
            if (typeof foto?.url !== 'string' || !URL.canParse(foto.url)) return false;
            const url = new URL(foto.url);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
        }).sort((a, b) => Number(b.portada === true) - Number(a.portada === true))
            .slice(0, 8).map(foto => ({ url: foto.url, portada: foto.portada === true }));
    }
    return { estado: resultados.length ? 'ok' : 'sin_resultados', consultadoEn: new Date().toISOString(), vehiculos: resultados };
}
module.exports = { disponible, buscar };
