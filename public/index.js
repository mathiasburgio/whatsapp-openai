let conversaciones = [];
let conversacionActual = null;
let mensajes = [];
let paginaMensajes = 0;
let cargandoMensajes = false;
let hayMasMensajes = false;
const socket = io({ autoConnect: false });

socket.on('connect', obtenerConversaciones);
socket.on('cambios', recibirCambios);
socket.on('disconnect', motivo => {
    if (motivo === 'io server disconnect') {
        conversaciones = [];
        conversacionActual = null;
        mensajes = [];
        $('body').attr('data-estado', 'login');
    }
});
socket.on('connect_error', error => {
    if (error.data?.sesionInactiva) {
        socket.disconnect();
        $('body').attr('data-estado', 'login');
    }
    Swal.fire({ icon: 'error', text: error.message });
});

function recibirCambios({ conversacion, mensaje }) {
    if (conversacion) {
        const actual = conversaciones.find(c => c._id === conversacion._id);
        if (actual) Object.assign(actual, conversacion);
        conversaciones = [actual || conversacion, ...conversaciones.filter(c => c._id !== conversacion._id)];
        listarConversaciones();
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
        socket.timeout(15000).emit('enviar-mensaje', { conversacionId, contenido }, (error, respuesta) => {
            if (error) return reject(new Error('No se pudo confirmar el envío.'));
            if (respuesta.error) {
                if (respuesta.sesionInactiva) {
                    socket.disconnect();
                    $('body').attr('data-estado', 'login');
                }
                return reject(new Error(respuesta.error));
            }
            resolve(respuesta.mensaje);
        });
    });
}

async function iniciarSesion(){
    $('#btn-iniciar-sesion').prop('disabled', true);
    try{
        await $.post({
            url: '/iniciar-sesion',
            contentType: 'application/json',
            data: JSON.stringify({
                email: $('#email').val().trim().toLowerCase(),
                contrasena: $('#contrasena').val()
            })
        });
        $('#contrasena').val('');
        $('body').attr('data-estado', 'conversacion');
        socket.connect();
    }catch(error){
        Swal.fire({ icon: 'error', text: error.responseJSON?.error || 'No se pudo iniciar sesión.' });
    }finally{
        $('#btn-iniciar-sesion').prop('disabled', false);
    }
}

async function cerrarSesion(){
    try{
        await $.post('/cerrar-sesion');
        socket.disconnect();
        conversaciones = [];
        conversacionActual = null;
        mensajes = [];
        hayMasMensajes = false;
        $('#lista-conversaciones, #mensajes').empty();
        $('#nombre-conversacion').text('Seleccioná una conversación');
        $('#telefono-conversacion').text('');
        $('#texto-mensaje, #contrasena, #buscar-conversacion').val('');
        $('#texto-mensaje, #btn-enviar-mensaje').prop('disabled', true);
        $('body').attr('data-estado', 'login');
    }catch(error){
        Swal.fire({ icon: 'error', text: error.responseJSON?.error || 'No se pudo cerrar sesión.' });
    }
}

async function obtenerConversaciones(){
    try{
        conversaciones = await $.get('/conversaciones');
        listarConversaciones();
        const conversacionId = conversacionActual?._id || conversaciones[0]?._id;
        if (conversacionId) await obtenerMensajes(conversacionId);
        return conversaciones;
    }catch(error){
        if (error.status === 401) $('body').attr('data-estado', 'login');
        Swal.fire({ icon: 'error', text: error.responseJSON?.error || 'No se pudieron obtener las conversaciones.' });
    }
}

function escaparHtml(texto) {
    const caracteres = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(texto ?? '').replace(/[&<>"']/g, caracter => caracteres[caracter]);
}

function listarConversaciones(){
    const buscar = $('#buscar-conversacion').val().trim().toLowerCase();
    const html = conversaciones.map(conversacion => {
        const telefono = conversacion.telefono || '';
        const nombre = conversacion.nombre || telefono || 'Sin nombre';
        if (!(nombre + ' ' + telefono).toLowerCase().includes(buscar)) return '';
        const ultimoMensaje = conversacion.ultimoMensaje;
        const enviado = ultimoMensaje?.deSistemaParaCliente;
        const estado = ultimoMensaje?.fechaLeida ? 'leido' : ultimoMensaje?.fechaEntrega ? 'entregado' : 'emitido';
        const leadGuardado = conversacion.intereses?.at(-1)?.lead?.toLowerCase();
        const lead = { frio: 'cold', frío: 'cold', cold: 'cold', tibio: 'warm', warm: 'warm',
            caliente: 'hot', hot: 'hot', derivación: 'handoff', derivacion: 'handoff', handoff: 'handoff' }[leadGuardado] || 'cold';
        const seleccionada = conversacionActual?._id === conversacion._id;
        const estadoTexto = { leido: 'Leído', entregado: 'Entregado', emitido: 'Enviado' }[estado];
        return `
            <button type="button" class="conversacion ${seleccionada ? 'seleccionada' : ''}"
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
        obtenerMensajes($(ev.currentTarget).attr('data-conversacion-id'));
    });
}

async function obtenerMensajes(conversacionId, pagina = 0){
    const conversacion = conversaciones.find(c => c._id === conversacionId);
    if (!conversacion || (pagina > 0 && cargandoMensajes)) return;
    if (pagina === 0) {
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
    }
    cargandoMensajes = true;
    $('#texto-mensaje, #btn-enviar-mensaje').prop('disabled', true);
    try{
        const respuesta = await $.get('/mensajes', { conversacionId, pagina });
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
            $('#texto-mensaje, #btn-enviar-mensaje').prop('disabled', false);
        }
    }
}

function listarMensajes(){
    $('#mensajes').empty();
    mensajes.forEach(mensaje => {
        const enviado = mensaje.deSistemaParaCliente;
        const fila = $('<article>', { class: 'mensaje mensaje-' + (enviado ? 'enviado' : 'recibido'), 'aria-label': enviado ? 'Mensaje enviado' : 'Mensaje recibido' });
        fila.append($('<p>').text(mensaje.contenido || mensaje.transcripcionAudio || mensaje.transcripcionImagen || ''));
        const fecha = new Date(mensaje.fechaEmitida || mensaje.createdAt);
        const meta = $('<div>', { class: 'mensaje-meta' });
        if (!Number.isNaN(fecha.getTime())) {
            meta.append($('<time>', { datetime: fecha.toISOString(), title: fecha.toLocaleString('es-AR') })
                .text(fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })));
        }
        if (enviado) meta.append($('<i>', {
            class: 'fa-solid fa-check' + (mensaje.fechaLeida || mensaje.fechaEntrega ? '-double' : '') + (mensaje.fechaLeida ? ' estado-leido' : ''),
            'aria-label': mensaje.fechaLeida ? 'Leído' : mensaje.fechaEntrega ? 'Entregado' : 'Enviado'
        }));
        $('#mensajes').append(fila.append(meta));
    });
    $('#mensajes').scrollTop($('#mensajes')[0].scrollHeight);
}

async function enviarMensaje(){
    const contenido = $('#texto-mensaje').val().trim();
    const conversacion = conversacionActual;
    if (!conversacion || !contenido || $('#btn-enviar-mensaje').prop('disabled')) return;
    $('#btn-enviar-mensaje').prop('disabled', true);
    try{
        const mensaje = await enviarPorSocket(conversacion._id, contenido);
        if (conversacionActual?._id === conversacion._id) {
            recibirCambios({ mensaje });
            if ($('#texto-mensaje').val().trim() === contenido) $('#texto-mensaje').val('');
        }
        Object.assign(conversacion, {
            deClienteParaSistema: false,
            ultimoMensaje: mensaje
        });
        conversaciones = [conversacion, ...conversaciones.filter(c => c._id !== conversacion._id)];
        listarConversaciones();
    }catch(error){
        if (error.status === 401) $('body').attr('data-estado', 'login');
        Swal.fire({ icon: 'error', text: error.message || 'No se pudo enviar el mensaje.' });
    }finally{
        $('#btn-enviar-mensaje').prop('disabled', !conversacionActual || cargandoMensajes);
    }
}

$('#form-login').on('submit', ev => { ev.preventDefault(); iniciarSesion(); });
$('#buscar-conversacion').on('input', listarConversaciones);
$('#btn-enviar-mensaje').on('click', enviarMensaje);
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

$.get('/verificar-sesion').then(r => {
    if (r.sesionActiva) {
        $('body').attr('data-estado', 'conversacion');
        socket.connect();
    }
}).catch(() => {
    $('body').attr('data-estado', 'login');
});
