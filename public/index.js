let conversaciones = [];
let conversacionActual = null;
let mensajes = [];
let paginaMensajes = 0;
let cargandoMensajes = false;
let hayMasMensajes = false;
let guardandoBot = null;
let solicitudMetricas = 0;
let promptsDisponibles = [];
let promptActual = null;
let contenidoInicialPrompt = '';
let solicitudPrompts = 0;
let guardandoPrompt = false;
let resolverDescartePrompt = null;
let modoListado = 'ultimas';
let solicitudConversaciones = 0;
let enviandoMensaje = false;
const socket = io({ autoConnect: false });

socket.on('connect', obtenerConversaciones);
socket.on('cambios', recibirCambios);
socket.on('disconnect', motivo => {
    if (motivo === 'io server disconnect') {
        solicitudConversaciones++;
        conversaciones = [];
        conversacionActual = null;
        mensajes = [];
        limpiarMetricas();
        limpiarPrompts();
        cerrarDetalleMensaje();
        actualizarControlBot();
        $('body').attr('data-estado', 'login');
    }
});
socket.on('connect_error', error => {
    if (error.data?.sesionInactiva) {
        solicitudConversaciones++;
        socket.disconnect();
        $('body').attr('data-estado', 'login');
        limpiarPrompts();
        limpiarMetricas();
        cerrarDetalleMensaje();
    }
    Swal.fire({ icon: 'error', text: error.message });
});

function recibirCambios({ conversacion, mensaje }) {
    if (conversacion) {
        const actual = conversaciones.find(c => c._id === conversacion._id);
        if (actual) Object.assign(actual, conversacion);
        if (conversacionActual?._id === conversacion._id) Object.assign(conversacionActual, conversacion);
        conversaciones = [actual || conversacion, ...conversaciones.filter(c => c._id !== conversacion._id)];
        listarConversaciones();
        actualizarControlBot();
    }
    if (mensaje && conversacionActual?._id === mensaje.conversacionId) {
        const posicion = mensajes.findIndex(m => m._id === mensaje._id);
        if (posicion === -1) mensajes.push(mensaje);
        else mensajes[posicion] = mensaje;
        listarMensajes();
    }
}

function enviarPorSocket(conversacionId, contenido) {
    return new Promise((resolve, reject) => {
        if (!socket.connected) return reject(new Error('No hay conexión con el servidor.'));
        socket.timeout(30000).emit('enviar-mensaje', { conversacionId, contenido }, (error, respuesta) => {
            if (error) return reject(new Error('No se pudo confirmar el envío.'));
            if (respuesta.error) {
                if (respuesta.mensaje) recibirCambios({ mensaje: respuesta.mensaje });
                if (respuesta.sesionInactiva) {
                    solicitudConversaciones++;
                    socket.disconnect();
                    $('body').attr('data-estado', 'login');
                }
                return reject(Object.assign(new Error(respuesta.error), { mensaje: respuesta.mensaje }));
            }
            resolve(respuesta.mensaje);
        });
    });
}

async function iniciarSesion(){
    $('#btn-iniciar-sesion').prop('disabled', true);
    try{
        await $.post({
            url: '/sesion/iniciar',
            contentType: 'application/json',
            data: JSON.stringify({
                email: $('#email').val().trim().toLowerCase(),
                contrasena: $('#contrasena').val()
            })
        });
        $('#contrasena').val('').attr('type', 'password');
        $('#mostrar-contrasena').prop('checked', false);
        $('body').attr('data-estado', 'conversacion');
        socket.connect();
    }catch(error){
        Swal.fire({ icon: 'error', text: error.responseJSON?.error || 'No se pudo iniciar sesión.' });
    }finally{
        $('#btn-iniciar-sesion').prop('disabled', false);
    }
}

async function cerrarSesion(){
    $('#btn-cerrar-sesion').prop('disabled', true);
    try{
        await $.post('/sesion/cerrar');
        solicitudConversaciones++;
        socket.disconnect();
        conversaciones = [];
        conversacionActual = null;
        mensajes = [];
        hayMasMensajes = false;
        $('#lista-conversaciones, #mensajes').empty();
        $('#nombre-conversacion').text('Seleccioná una conversación');
        $('#telefono-conversacion').text('');
        $('#texto-mensaje, #contrasena, #buscar-conversacion').val('');
        $('#contrasena').attr('type', 'password');
        $('#mostrar-contrasena').prop('checked', false);
        $('#texto-mensaje, #btn-enviar-mensaje').prop('disabled', true);
        actualizarControlBot();
        limpiarMetricas();
        limpiarPrompts();
        cerrarDetalleMensaje();
        $('body').attr('data-estado', 'login');
    }catch(error){
        Swal.fire({ icon: 'error', text: error.responseJSON?.error || 'No se pudo cerrar sesión.' });
    }finally{
        $('#btn-cerrar-sesion').prop('disabled', false);
    }
}

async function obtenerConversaciones(){
    const solicitud = ++solicitudConversaciones;
    try{
        const respuesta = await $.get('/conversaciones/obtener', { orden: modoListado });
        if (solicitud !== solicitudConversaciones) return;
        conversaciones = respuesta;
        listarConversaciones();
        const conversacionId = conversaciones.find(c => c._id === conversacionActual?._id)?._id || ordenarConversaciones(conversaciones)[0]?._id;
        if (conversacionId) await obtenerMensajes(conversacionId);
        else {
            conversacionActual = null; mensajes = []; hayMasMensajes = false;
            $('#mensajes').empty(); $('#nombre-conversacion').text('Seleccioná una conversación');
            $('#telefono-conversacion').text('');
            $('#texto-mensaje, #btn-enviar-mensaje').prop('disabled', true);
            actualizarControlBot();
        }
        return conversaciones;
    }catch(error){
        if (error.status === 401) $('body').attr('data-estado', 'login');
        Swal.fire({ icon: 'error', text: error.responseJSON?.error || 'No se pudieron obtener las conversaciones.' });
    }
}

function faltaResponder(conversacion) {
    return !!conversacion.requiereAtencion || !!conversacion.ultimoMensaje?.deClienteParaSistema;
}
function ordenarConversaciones(lista) {
    return [...lista].sort((a, b) => Number(!!b.requiereAtencion) - Number(!!a.requiereAtencion)
        || (new Date(b.updatedAt || b.ultimoMensaje?.fechaEmitida).getTime() || 0) - (new Date(a.updatedAt || a.ultimoMensaje?.fechaEmitida).getTime() || 0));
}
function cambiarVistaListado(modo) {
    modoListado = modo;
    $('#btn-orden-ultimas').attr('aria-pressed', modo === 'ultimas' ? 'true' : 'false');
    $('#btn-orden-pendientes').attr('aria-pressed', modo === 'pendientes' ? 'true' : 'false');
    listarConversaciones();
    obtenerConversaciones();
}

function escaparHtml(texto) {
    const caracteres = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(texto ?? '').replace(/[&<>"']/g, caracter => caracteres[caracter]);
}

function actualizarControlBot() {
    const botActivo = !!conversacionActual?.botActivo;
    $('#bot-activo').prop('checked', botActivo)
        .prop('disabled', !conversacionActual || guardandoBot === conversacionActual._id);
    $('#estado-bot').text(botActivo ? 'Bot activo' : 'Bot inactivo');
    $('.control-bot').attr('data-activo', String(botActivo));

    $('#atencion-vendedor').prop('hidden', !conversacionActual?.requiereAtencion);
    $('#motivo-vendedor').text(conversacionActual?.motivoDerivacion || 'Consulta derivada.');
    $('#resumen-conversacion').text(conversacionActual
        ? conversacionActual.resumen || 'Todavía no hay un resumen generado.'
        : 'Seleccioná una conversación.');
}

async function cambiarEstadoBot() {
    const conversacion = conversacionActual;
    if (!conversacion || guardandoBot) { actualizarControlBot(); return; }
    const botActivo = $('#bot-activo').prop('checked');
    guardandoBot = conversacion._id;
    $('#bot-activo').prop('disabled', true);
    try {
        const accion = botActivo ? 'habilitar-bot' : 'deshabilitar-bot';
        const actualizada = await $.post({ url: '/conversaciones/' + accion,
            contentType: 'application/json', data: JSON.stringify({ conversacionId: conversacion._id }) });
        // Una respuesta tardía no debe cambiar la selección ni restaurar datos tras cerrar sesión.
        if (conversaciones.some(actual => actual._id === conversacion._id)) recibirCambios({ conversacion: actualizada });
    } catch (error) {
        if (error.status === 401) { socket.disconnect(); $('body').attr('data-estado', 'login'); limpiarMetricas(); }
        Swal.fire({ icon: 'error', text: error.responseJSON?.error || 'No se pudo cambiar el estado del bot.' });
    } finally {
        guardandoBot = null;
        actualizarControlBot();
    }
}

function mostrarDetalleMensaje(mensajeId) {
    const mensaje = mensajes.find(item => String(item._id) === mensajeId);
    if (!mensaje) return;

    $('#mensaje-json').text(JSON.stringify(mensaje, null, 2));
    const modal = document.getElementById('modal-mensaje');
    if (!modal.open) modal.showModal();
}

function cerrarDetalleMensaje() {
    const modal = document.getElementById('modal-mensaje');
    if (modal?.open) modal.close();
    $('#mensaje-json').text('');
}

function limpiarMetricas() {
    solicitudMetricas++;
    cerrarMetricas();
    $('#metricas-contenido').prop('hidden', true);
    $('#periodo-metricas, #metricas-detalle-tokens').text('');
    $('#metrica-web, #metrica-textos, #metrica-segundos, #metrica-tokens, #metrica-imagenes, #metrica-respuestas').text('—');
}

function cerrarMetricas() {
    const modal = document.getElementById('modal-metricas');
    if (!modal?.open) return;
    if (typeof modal.close === 'function') modal.close();
    else modal.removeAttribute('open');
}

async function mostrarMetricas() {
    const solicitud = ++solicitudMetricas;
    const modal = document.getElementById('modal-metricas');
    $('#metricas-contenido').prop('hidden', true);
    $('#periodo-metricas').text('');
    $('#metricas-estado').prop('hidden', false).text('Cargando métricas…');
    if (!modal.open) {
        if (typeof modal.showModal === 'function') modal.showModal();
        else modal.setAttribute('open', '');
    }
    try {
        const metricas = await $.get('/metricas/mes');
        if (solicitud !== solicitudMetricas) return;
        const formato = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });
        $('#periodo-metricas').text(new Date(metricas.periodo.inicio).toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' }) + ' · UTC');
        for (const [id, campo] of Object.entries({ web: 'llamadasWebSearch', textos: 'llamadasProcesarTexto', segundos: 'segundosProcesados',
            tokens: 'tokensProcesados', imagenes: 'imagenesProcesadas', respuestas: 'respuestasAutomaticas' })) {
            $('#metrica-' + id).text(formato.format(metricas[campo] ?? 0));
        }
        $('#metricas-detalle-tokens').text('Tokens de entrada: ' + formato.format(metricas.tokensEntrada) + ' · Tokens de salida: ' + formato.format(metricas.tokensSalida));
        $('#metricas-estado').prop('hidden', true);
        $('#metricas-contenido').prop('hidden', false);
    } catch (error) {
        if (solicitud !== solicitudMetricas) return;
        $('#metricas-estado').text(error.responseJSON?.error || 'No se pudieron cargar las métricas. Cerrá el modal y volvé a intentar.');
        if (error.status === 401) { socket.disconnect(); $('body').attr('data-estado', 'login'); limpiarMetricas(); }
    }
}

function listarConversaciones(){
    const buscar = $('#buscar-conversacion').val().trim().toLowerCase();
    const html = ordenarConversaciones(conversaciones).filter(conversacion => modoListado !== 'pendientes' || faltaResponder(conversacion)).map(conversacion => {
        const telefono = conversacion.telefono || '';
        const nombre = conversacion.nombre || telefono || 'Sin nombre';
        if (!(nombre + ' ' + telefono).toLowerCase().includes(buscar)) return '';
        const ultimoMensaje = conversacion.ultimoMensaje;
        const enviado = ultimoMensaje?.deSistemaParaCliente;
        const estado = ultimoMensaje?.fechaLeida ? 'leido' : ultimoMensaje?.fechaEntregada ? 'entregado' : 'emitido';
        const leadGuardado = conversacion.requiereAtencion ? 'derivación' : conversacion.intereses?.at(-1)?.lead?.toLowerCase();
        const lead = { frio: 'cold', frío: 'cold', cold: 'cold', tibio: 'warm', warm: 'warm',
            caliente: 'hot', hot: 'hot', derivación: 'handoff', derivacion: 'handoff', handoff: 'handoff' }[leadGuardado] || 'cold';
        const seleccionada = conversacionActual?._id === conversacion._id;
        const estadoTexto = { leido: 'Leído', entregado: 'Entregado', emitido: 'Enviado' }[estado];
        return `
            <button type="button" class="conversacion ${seleccionada ? 'seleccionada' : ''} ${conversacion.requiereAtencion ? 'requiere-vendedor' : ''}"
                data-conversacion-id="${escaparHtml(conversacion._id)}" ${seleccionada ? 'aria-current="true"' : ''}>
                <span class="nombre-contacto">${escaparHtml(nombre)}</span>
                <span class="telefono-contacto">${escaparHtml(telefono)}</span>
                <span class="estado-mensaje">
                    <i class="fa-solid fa-arrow-${enviado ? 'up' : 'down'}" aria-hidden="true"></i>
                    ${enviado ? 'Enviado' : 'Recibido'}
                    <span class="separador">·</span>
                    <span class="${estado === 'leido' ? 'estado-leido' : ''}">
                        <i class="fa-solid fa-check${estado !== 'emitido' ? '-double' : ''}" aria-hidden="true"></i>
                        ${estadoTexto}
                    </span>
                </span>
                <span class="tags-conversacion">
                    ${conversacion.requiereAtencion ? '<span class="badge tag lead-warm">Requiere vendedor</span>' : ''}
                    <span class="badge tag lead-${lead}">${lead}</span>
                    <span class="badge tag bot-${conversacion.botActivo ? 'activo' : 'inactivo'}">
                        <i class="fa-solid fa-circle" aria-hidden="true"></i>
                        ${conversacion.botActivo ? 'Bot activo' : 'Bot inactivo'}
                    </span>
                </span>
            </button>`;
    }).join('');
    $('#lista-conversaciones').html(html);
    $('#lista-conversaciones .conversacion').on('click', ev => {
        const conversacionId = $(ev.currentTarget).attr('data-conversacion-id');
        const conversacion = conversaciones.find(c => c._id === conversacionId);
        if (conversacion) console.log({ numero: conversacion.telefono, nombre: conversacion.nombre, conversacion });
        obtenerMensajes(conversacionId);
    });
}

async function obtenerMensajes(conversacionId, pagina = 0){
    const conversacion = conversaciones.find(c => c._id === conversacionId);
    if (!conversacion || (pagina > 0 && cargandoMensajes)) return;
    if (pagina === 0) {
        cerrarDetalleMensaje();
        conversacionActual = conversacion;
        mensajes = [];
        paginaMensajes = 0;
        hayMasMensajes = false;
        $('#mensajes').empty();
        $('#texto-mensaje').val('');
        const telefono = conversacion.telefono || '';
        $('#nombre-conversacion').text(conversacion.nombre || telefono || 'Sin nombre');
        $('#telefono-conversacion').text(telefono);
        $('#mensajes').attr('aria-label', 'Mensajes de ' + (conversacion.nombre || telefono));
        listarConversaciones();
        actualizarControlBot();
    }
    cargandoMensajes = true;
    $('#texto-mensaje, #btn-enviar-mensaje').prop('disabled', true);
    try{
        const respuesta = await $.get('/conversacion/mensajes', { conversacionId, pagina });
        if (conversacionActual?._id !== conversacionId) return;
        const altoAnterior = $('#mensajes')[0].scrollHeight;
        const posicionAnterior = $('#mensajes').scrollTop();
        mensajes = pagina === 0 ? respuesta.reverse()
            : respuesta.reverse().filter(m => !mensajes.some(actual => actual._id === m._id)).concat(mensajes);
        paginaMensajes = pagina;
        hayMasMensajes = respuesta.length === 50;
        listarMensajes();
        if (pagina > 0) $('#mensajes').scrollTop($('#mensajes')[0].scrollHeight - altoAnterior + posicionAnterior);
    }catch(error){
        if (error.status === 401) $('body').attr('data-estado', 'login');
        Swal.fire({ icon: 'error', text: error.responseJSON?.error || 'No se pudieron obtener los mensajes.' });
    }finally{
        if (conversacionActual?._id === conversacionId) {
            cargandoMensajes = false;
            $('#texto-mensaje').prop('disabled', enviandoMensaje);
            $('#btn-enviar-mensaje').prop('disabled', enviandoMensaje || !socket.connected);
        }
    }
}

function textoOriginal(mensaje) {
    if (mensaje.contenidoOriginal !== undefined && mensaje.contenidoOriginal !== null) return mensaje.contenidoOriginal;
    if (mensaje.esImagen && mensaje.crudo?.image) return mensaje.crudo.image.caption || '';
    if (mensaje.esAudio && mensaje.crudo?.audio) return '';
    let texto = mensaje.contenido || '';
    // Compatibilidad con mensajes guardados antes de separar el texto y las inferencias.
    for (const inferencia of [mensaje.transcripcionImagen, mensaje.transcripcionAudio].filter(Boolean).reverse()) {
        if (texto === inferencia) texto = '';
        else if (texto.endsWith('\n' + inferencia)) texto = texto.slice(0, -inferencia.length - 1);
    }
    return ['[Imagen]', '[Audio]'].includes(texto) && (mensaje.esImagen || mensaje.esAudio) ? '' : texto;
}

function listarMensajes(){
    const contenedor = $('#mensajes')[0];
    const filas = new Map(Array.from(contenedor.children).map(fila => [fila.dataset.mensajeId, fila]));
    const vigentes = new Set(mensajes.map(mensaje => String(mensaje._id)));
    for (const [id, fila] of filas) if (!vigentes.has(id)) fila.remove();
    mensajes.forEach((mensaje, posicion) => {
        const id = String(mensaje._id);
        const enviado = mensaje.deSistemaParaCliente;
        let fila = filas.has(id) ? $(filas.get(id)) : $('<article>', { 'data-mensaje-id': id });
        fila.attr({ class: 'mensaje mensaje-' + (enviado ? 'enviado' : 'recibido'), 'aria-label': enviado ? 'Mensaje enviado' : 'Mensaje recibido',
            title: 'Doble clic para ver el mensaje en JSON' });
        if (!filas.has(id)) {
            fila.append($('<div>', { class: 'mensaje-media' }), $('<div>', { class: 'mensaje-textos' }), $('<div>', { class: 'mensaje-meta' }));
        }
        const media = fila.find('.mensaje-media');
        // Conserva los elementos multimedia al actualizar por socket, incluido el audio que está reproduciéndose.
        for (const [tipo, archivo] of [['imagen', mensaje.imagenArchivo], ['audio', mensaje.audioArchivo]]) {
            if (!archivo || media.find('[data-media-tipo="' + tipo + '"]').length) continue;
            const url = '/uploads/' + (tipo === 'imagen' ? 'imagenes' : 'audio') + '/' + encodeURIComponent(archivo);
            const bloque = $('<div>', { 'data-media-tipo': tipo });
            const elemento = tipo === 'audio'
                ? $('<audio>', { controls: true, preload: 'none', src: url, 'aria-label': 'Reproducir audio del mensaje' })
                : $('<img>', { src: url, alt: 'Imagen enviada en la conversación', loading: 'lazy', class: 'mensaje-imagen' });
            elemento.on('error', () => {
                if (!bloque.find('.media-error').length) bloque.append($('<p>', { class: 'media-error' }).text('No se pudo cargar ' + (tipo === 'audio' ? 'el audio.' : 'la imagen.')));
            });
            bloque.append(elemento);
            media.append(bloque);
        }
        const textos = fila.find('.mensaje-textos').empty();
        const original = textoOriginal(mensaje);
        if (original) textos.append($('<p>', { class: 'mensaje-original' }).text(original));
        if (mensaje.transcripcionImagen) {
            textos.append($('<aside>', { class: 'mensaje-inferencia', 'aria-label': 'Inferencia de IA sobre la imagen' })
                .append($('<span>', { class: 'inferencia-etiqueta' }).text('Inferencia de IA'), $('<p>').text(mensaje.transcripcionImagen)));
        }
        if (mensaje.transcripcionAudio) {
            textos.append($('<div>', { class: 'mensaje-transcripcion' })
                .append($('<span>', { class: 'inferencia-etiqueta' }).text('Transcripción del audio'), $('<p>').text(mensaje.transcripcionAudio)));
        }
        const fecha = new Date(mensaje.fechaEmitida || mensaje.createdAt);
        const meta = fila.find('.mensaje-meta').empty();
        if (!Number.isNaN(fecha.getTime())) {
            meta.append($('<time>', { datetime: fecha.toISOString(), title: fecha.toLocaleString('es-AR') })
                .text(fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })));
        }
        if (enviado && mensaje.fechaEmitida) meta.append($('<i>', {
            class: 'fa-solid fa-check' + (mensaje.fechaLeida || mensaje.fechaEntregada ? '-double' : '') + (mensaje.fechaLeida ? ' estado-leido' : ''),
            'aria-label': mensaje.fechaLeida ? 'Leído' : mensaje.fechaEntregada ? 'Entregado' : 'Enviado'
        }));
        if (contenedor.children[posicion] !== fila[0]) contenedor.insertBefore(fila[0], contenedor.children[posicion] || null);
    });
    $('#mensajes').scrollTop($('#mensajes')[0].scrollHeight);
}

async function enviarMensaje(){
    const contenido = $('#texto-mensaje').val().trim();
    const conversacion = conversacionActual;
    if (!conversacion || !contenido || enviandoMensaje || $('#btn-enviar-mensaje').prop('disabled')) return;
    if (contenido.length > 4096) { Swal.fire({ icon: 'error', text: 'El mensaje admite hasta 4096 caracteres.' }); return; }
    enviandoMensaje = true;
    $('#texto-mensaje, #btn-enviar-mensaje').prop('disabled', true);
    try{
        const mensaje = await enviarPorSocket(conversacion._id, contenido);
        if (!conversaciones.some(c => c._id === conversacion._id)) return;
        if (conversacionActual?._id === conversacion._id) {
            recibirCambios({ mensaje });
            if ($('#texto-mensaje').val().trim() === contenido) $('#texto-mensaje').val('');
        }
        if (!conversacion.ultimoMensaje?.fechaEmitida || new Date(conversacion.ultimoMensaje.fechaEmitida) <= new Date(mensaje.fechaEmitida)) {
            Object.assign(conversacion, { deClienteParaSistema: false, ultimoMensaje: mensaje });
        }
        conversaciones = [conversacion, ...conversaciones.filter(c => c._id !== conversacion._id)];
        listarConversaciones();
    }catch(error){
        if (error.status === 401) $('body').attr('data-estado', 'login');
        Swal.fire({ icon: 'error', text: error.message || 'No se pudo enviar el mensaje.' });
    }finally{
        enviandoMensaje = false;
        $('#texto-mensaje').prop('disabled', !conversacionActual || cargandoMensajes);
        $('#btn-enviar-mensaje').prop('disabled', !conversacionActual || cargandoMensajes || !socket.connected);
    }
}

function contenidoEditor() {
    return $('#prompt-contenido').val();
}
function hayCambiosPrompt() { return !!promptActual && contenidoEditor() !== contenidoInicialPrompt; }
function actualizarEstadoEditor() {
    $('#btn-guardar-prompt').prop('disabled', guardandoPrompt || !hayCambiosPrompt());
    $('#prompt-estado').text(hayCambiosPrompt() ? 'Cambios sin guardar.' : '');
}
function seleccionarPrompt(id) {
    promptActual = promptsDisponibles.find(item => item.id === id) || null;
    if (!promptActual) return;
    $('#prompt-selector').val(id);
    $('#prompt-descripcion').text(promptActual.descripcion);
    $('#prompt-contenido').val(promptActual.contenido).prop('disabled', false);
    contenidoInicialPrompt = contenidoEditor();
    actualizarEstadoEditor();
}
function confirmarDescartar() {
    if (!hayCambiosPrompt()) return Promise.resolve(true);
    if (resolverDescartePrompt) return Promise.resolve(false);
    document.getElementById('modal-descartar-prompts').showModal();
    return new Promise(resolve => { resolverDescartePrompt = resolve; });
}
function resolverDescarte(descartar) {
    const modal = document.getElementById('modal-descartar-prompts');
    if (modal?.open) modal.close();
    const resolver = resolverDescartePrompt;
    resolverDescartePrompt = null;
    resolver?.(descartar);
}
async function cargarPrompts() {
    if (guardandoPrompt || !await confirmarDescartar()) return;
    const solicitud = ++solicitudPrompts;
    const id = promptActual?.id;
    promptActual = null;
    $('#prompt-estado').text('Cargando…');
    $('#prompt-selector, #prompt-contenido, #btn-guardar-prompt').prop('disabled', true);
    try {
        const lista = await $.get('/prompts/obtener');
        if (solicitud !== solicitudPrompts) return;
        promptsDisponibles = lista;
        $('#prompt-selector').html(lista.map(item => `<option value="${escaparHtml(item.id)}">${escaparHtml(item.nombre)}</option>`).join('')).prop('disabled', false);
        seleccionarPrompt(lista.some(item => item.id === id) ? id : lista[0]?.id);
    } catch (error) {
        if (solicitud !== solicitudPrompts) return;
        $('#prompt-estado').text(error.responseJSON?.error || 'No se pudieron cargar los prompts.');
        if (error.status === 401) { socket.disconnect(); $('body').attr('data-estado', 'login'); limpiarPrompts(); }
    }
}
function mostrarPrompts() {
    const modal = document.getElementById('modal-prompts');
    if (!modal.open) modal.showModal();
    cargarPrompts();
}
async function cerrarPrompts() {
    if (guardandoPrompt || !await confirmarDescartar()) return;
    limpiarPrompts();
}
function limpiarPrompts() {
    resolverDescarte(false);
    solicitudPrompts++;
    promptsDisponibles = [];
    promptActual = null;
    contenidoInicialPrompt = '';
    const modal = document.getElementById('modal-prompts');
    if (modal?.open) modal.close();
    $('#prompt-contenido').val('');
    $('#prompt-selector').empty();
    $('#btn-guardar-prompt').prop('disabled', true);
}
async function guardarPrompt() {
    if (!promptActual || guardandoPrompt || !hayCambiosPrompt()) return;
    const solicitud = solicitudPrompts;
    const actual = promptActual;
    const contenido = contenidoEditor();
    guardandoPrompt = true;
    $('#modal-prompts input, #modal-prompts textarea, #modal-prompts select, #modal-prompts button').prop('disabled', true);
    $('#prompt-estado').text('Guardando…');
    try {
        const actualizado = await $.post({ url: '/prompts/guardar', contentType: 'application/json',
            data: JSON.stringify({ id: actual.id, contenido, version: actual.version }) });
        if (solicitud !== solicitudPrompts) return;
        Object.assign(actual, actualizado);
        contenidoInicialPrompt = contenido;
        $('#prompt-estado').text('Cambios guardados. Se usarán en los próximos mensajes.');
    } catch (error) {
        if (solicitud !== solicitudPrompts) return;
        $('#prompt-estado').text(error.responseJSON?.error || 'No se pudo guardar. Tus cambios siguen en el editor.');
        if (error.status === 401) { socket.disconnect(); $('body').attr('data-estado', 'login'); limpiarPrompts(); }
    } finally {
        guardandoPrompt = false;
        $('#modal-prompts input, #modal-prompts textarea, #modal-prompts select, #modal-prompts button').prop('disabled', false);
        $('#btn-guardar-prompt').prop('disabled', !hayCambiosPrompt());
    }
}

$('#btn-prompts').on('click', mostrarPrompts);
$('#btn-descartar-prompt').on('click', () => resolverDescarte(true));
$('#btn-conservar-prompt').on('click', () => resolverDescarte(false));
$('#modal-descartar-prompts').on('cancel', ev => { ev.preventDefault(); resolverDescarte(false); });
$('[data-cerrar-prompts]').on('click', cerrarPrompts);
$('#modal-prompts').on('cancel', ev => { ev.preventDefault(); cerrarPrompts(); });
$('#btn-guardar-prompt').on('click', guardarPrompt);
$('#btn-recargar-prompts').on('click', cargarPrompts);
$('#prompt-contenido').on('input', actualizarEstadoEditor);
$('#prompt-selector').on('change', async () => {
    const id = $('#prompt-selector').val();
    if (await confirmarDescartar()) seleccionarPrompt(id);
    else $('#prompt-selector').val(promptActual?.id);
});

$('#form-login').on('submit', ev => { ev.preventDefault(); iniciarSesion(); });
$('#mostrar-contrasena').on('change', () => {
    $('#contrasena').attr('type', $('#mostrar-contrasena').prop('checked') ? 'text' : 'password');
});
$('#mensajes').on('dblclick', '.mensaje', ev => {
    mostrarDetalleMensaje($(ev.currentTarget).attr('data-mensaje-id'));
});
$('[data-cerrar-mensaje]').on('click', cerrarDetalleMensaje);
$('#modal-mensaje').on('close', () => $('#mensaje-json').text(''));
$('#btn-orden-ultimas').on('click', () => cambiarVistaListado('ultimas'));
$('#btn-orden-pendientes').on('click', () => cambiarVistaListado('pendientes'));
$('#buscar-conversacion').on('input', listarConversaciones);
$('#btn-enviar-mensaje').on('click', enviarMensaje);
$('#btn-cerrar-sesion').on('click', cerrarSesion);
$('#btn-metricas').on('click', mostrarMetricas);
$('[data-cerrar-metricas]').on('click', cerrarMetricas);
$('#bot-activo').on('change', cambiarEstadoBot);
$('#texto-mensaje').on('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.originalEvent.isComposing) {
        ev.preventDefault();
        enviarMensaje();
    }
});
$('#mensajes').on('scroll', () => {
    if ($('#mensajes').scrollTop() === 0 && hayMasMensajes && !cargandoMensajes && conversacionActual) {
        obtenerMensajes(conversacionActual._id, paginaMensajes + 1);
    }
});

$.get('/sesion/activa').then(activa => {
    if (activa) {
        $('body').attr('data-estado', 'conversacion');
        socket.connect();
    }
}).catch(() => {
    $('body').attr('data-estado', 'login');
});
