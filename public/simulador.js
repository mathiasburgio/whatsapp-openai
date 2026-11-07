let adjuntoSimulador = null;
let urlAdjuntoSimulador = null;
let grabadorSimulador = null;
let streamSimulador = null;
let temporizadorGrabacion = null;
let relojGrabacion = null;
let solicitandoMicrofono = false;
let versionGrabacion = 0;
let reiniciandoSimulador = false;

function actualizarControlesSimulador() {
    const activo = conversacionActual?.canal === 'simulador' && $('body').attr('data-estado') === 'conversacion';
    $('#controles-simulador').prop('hidden', !activo);
    $('#texto-mensaje').attr('placeholder', activo ? 'Escribí como cliente Test' : 'Escribí un mensaje');
    if (!activo) {
        limpiarAdjuntoSimulador();
        return;
    }
    const grabando = !!grabadorSimulador;
    const ocupado = enviandoMensaje || cargandoMensajes || solicitandoMicrofono || reiniciandoSimulador;
    $('#espera-simulador, #btn-imagen-simulador, #btn-quitar-adjunto-simulador').prop('disabled', ocupado || grabando);
    $('#btn-grabar-simulador').prop('disabled', ocupado)
        .text(grabando ? 'Detener grabación' : 'Grabar audio');
    $('#btn-limpiar-simulador').prop('disabled', enviandoMensaje || cargandoMensajes || reiniciandoSimulador || !!guardandoBot)
        .text(reiniciandoSimulador ? 'Limpiando…' : 'Limpiar y empezar de cero');
    $('#texto-mensaje').prop('disabled', enviandoMensaje || cargandoMensajes || reiniciandoSimulador);
    $('#btn-enviar-mensaje').prop('disabled', ocupado || grabando || !socket.connected);
}

function liberarMicrofonoSimulador() {
    clearTimeout(temporizadorGrabacion);
    clearInterval(relojGrabacion);
    temporizadorGrabacion = null;
    relojGrabacion = null;
    if (streamSimulador) {
        for (const pista of streamSimulador.getTracks()) pista.stop();
        streamSimulador = null;
    }
}

function limpiarAdjuntoSimulador() {
    versionGrabacion++;
    solicitandoMicrofono = false;
    if (grabadorSimulador && grabadorSimulador.state !== 'inactive') grabadorSimulador.stop();
    grabadorSimulador = null;
    liberarMicrofonoSimulador();
    adjuntoSimulador = null;
    const audio = document.getElementById('preview-audio-simulador');
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    $('#preview-imagen-simulador').removeAttr('src').prop('hidden', true);
    $('#preview-audio-simulador, #adjunto-simulador').prop('hidden', true);
    if (urlAdjuntoSimulador) URL.revokeObjectURL(urlAdjuntoSimulador);
    urlAdjuntoSimulador = null;
    $('#imagen-simulador').val('');
    $('#estado-simulador').text('');
}

function mostrarAdjuntoSimulador(blob, tipo, duracionSegundos) {
    limpiarAdjuntoSimulador();
    adjuntoSimulador = { blob, tipo, duracionSegundos };
    urlAdjuntoSimulador = URL.createObjectURL(blob);
    const selector = tipo === 'imagen' ? '#preview-imagen-simulador' : '#preview-audio-simulador';
    $(selector).attr('src', urlAdjuntoSimulador).prop('hidden', false);
    $('#adjunto-simulador').prop('hidden', false);
    $('#estado-simulador').text(tipo === 'imagen' ? 'Imagen lista para enviar (máximo 5 MB).'
        : 'Audio listo para escuchar y enviar (' + Math.ceil(duracionSegundos) + ' s).');
    actualizarControlesSimulador();
}

async function solicitarSimulador(ruta, datos) {
    const respuesta = await fetch('/simulador/' + ruta, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos),
    });
    const resultado = await respuesta.json();
    if (respuesta.status === 401) {
        socket.disconnect();
        $('body').attr('data-estado', 'login');
        limpiarAdjuntoSimulador();
    }
    if (!respuesta.ok && resultado.conversacion && $('body').attr('data-estado') === 'conversacion') {
        recibirCambios({ conversacion: resultado.conversacion });
    }
    if (!respuesta.ok) throw new Error(resultado.error || 'No se pudo completar la operación del simulador.');
    return resultado;
}

async function abrirSimulador() {
    $('#btn-simulador').prop('disabled', true);
    try {
        const conversacion = await solicitarSimulador('abrir', {});
        if ($('body').attr('data-estado') !== 'conversacion') return;
        recibirCambios({ conversacion });
        $('#buscar-conversacion').val('');
        modoListado = 'ultimas';
        $('#btn-orden-ultimas').attr('aria-pressed', 'true');
        $('#btn-orden-pendientes').attr('aria-pressed', 'false');
        await obtenerMensajes(conversacion._id);
    } catch (error) {
        Swal.fire({ icon: 'error', text: error.message });
    } finally { $('#btn-simulador').prop('disabled', false); }
}

async function limpiarConversacionSimulador() {
    const conversacion = conversacionActual;
    if (conversacion?.canal !== 'simulador' || reiniciandoSimulador || enviandoMensaje || cargandoMensajes || guardandoBot) return;
    const versionSimulador = conversacion.versionSimulador || 0;
    const confirmacion = await Swal.fire({
        icon: 'warning', title: '¿Limpiar la conversación de Test?',
        text: 'Se borrarán los mensajes, imágenes, audios y el contexto de esta prueba para todos los paneles. El consumo de OpenAI se conserva.',
        showCancelButton: true, confirmButtonText: 'Limpiar y empezar de cero', cancelButtonText: 'Cancelar',
    });
    if (!confirmacion.isConfirmed || $('body').attr('data-estado') !== 'conversacion') return;
    reiniciandoSimulador = true;
    limpiarAdjuntoSimulador();
    actualizarControlBot();
    $('#estado-simulador').text('Limpiando la prueba. Si hay procesamiento en curso, esperamos a que termine antes de borrar.');
    try {
        const resultado = await solicitarSimulador('limpiar', { versionSimulador });
        if ($('body').attr('data-estado') !== 'conversacion') return;
        recibirCambios(resultado);
        if (conversacionActual?._id === conversacion._id) {
            $('#estado-simulador').text('Conversación limpia. El bot está activo y podés iniciar una prueba nueva.');
        }
    } catch (error) {
        Swal.fire({ icon: 'error', text: error.message });
    } finally {
        reiniciandoSimulador = false;
        actualizarControlBot();
    }
}

function seleccionarImagenSimulador(ev) {
    const archivo = ev.target.files[0];
    if (!archivo || conversacionActual?.canal !== 'simulador' || enviandoMensaje || cargandoMensajes
        || solicitandoMicrofono || grabadorSimulador || reiniciandoSimulador) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(archivo.type)
        || !archivo.size || archivo.size > 5_000_000) {
        $('#imagen-simulador').val('');
        Swal.fire({ icon: 'error', text: 'Elegí una imagen JPG, PNG, WebP o GIF de hasta 5 MB.' });
        return;
    }
    mostrarAdjuntoSimulador(archivo, 'imagen');
}

function detenerGrabacionSimulador() {
    if (grabadorSimulador?.state === 'recording') grabadorSimulador.stop();
    liberarMicrofonoSimulador();
}

async function alternarGrabacionSimulador() {
    if (conversacionActual?.canal !== 'simulador' || enviandoMensaje || cargandoMensajes || solicitandoMicrofono || reiniciandoSimulador) return;
    if (grabadorSimulador) { detenerGrabacionSimulador(); return; }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        Swal.fire({ icon: 'error', text: 'Para grabar necesitás un navegador compatible y abrir el panel con HTTPS o localhost.' });
        return;
    }
    const solicitud = ++versionGrabacion;
    let versionActiva = solicitud;
    const conversacionId = conversacionActual._id;
    solicitandoMicrofono = true;
    actualizarControlesSimulador();
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (solicitud !== versionGrabacion || conversacionActual?._id !== conversacionId
            || $('body').attr('data-estado') !== 'conversacion') {
            for (const pista of stream.getTracks()) pista.stop();
            return;
        }
        limpiarAdjuntoSimulador();
        const version = versionGrabacion;
        versionActiva = version;
        streamSimulador = stream;
        const formatos = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
        const mimeType = formatos.find(function admiteFormatoGrabacion(formato) { return MediaRecorder.isTypeSupported(formato); });
        if (!mimeType) throw new Error('Este navegador no permite grabar en un formato compatible.');
        const grabador = new MediaRecorder(stream, { mimeType });
        grabadorSimulador = grabador;
        const fragmentos = [];
        let bytes = 0;
        const inicio = performance.now();
        grabador.addEventListener('dataavailable', function guardarFragmentoGrabacion(evento) {
            if (version !== versionGrabacion || !evento.data.size) return;
            bytes += evento.data.size;
            if (bytes > 15_000_000) {
                limpiarAdjuntoSimulador();
                actualizarControlesSimulador();
                $('#estado-simulador').text('La grabación superó 15 MB. Grabá un audio más corto.');
                return;
            }
            fragmentos.push(evento.data);
        });
        grabador.addEventListener('stop', function prepararAudioGrabado() {
            if (version !== versionGrabacion) return;
            const duracionSegundos = Math.min(120, Math.max(1, (performance.now() - inicio) / 1000));
            grabadorSimulador = null;
            liberarMicrofonoSimulador();
            const blob = new Blob(fragmentos, { type: grabador.mimeType || mimeType });
            if (!blob.size) {
                actualizarControlesSimulador();
                $('#estado-simulador').text('No se grabó audio. Volvé a intentarlo.');
                return;
            }
            mostrarAdjuntoSimulador(blob, 'audio', duracionSegundos);
        });
        grabador.addEventListener('error', function mostrarErrorGrabacion() {
            if (version !== versionGrabacion) return;
            limpiarAdjuntoSimulador();
            actualizarControlesSimulador();
            $('#estado-simulador').text('No se pudo grabar el audio. Volvé a intentarlo.');
        });
        grabador.start(1000);
        $('#estado-simulador').text('Grabando… Detené la grabación para escucharla. Máximo 2 minutos.');
        relojGrabacion = setInterval(function actualizarTiempoGrabacion() {
            $('#estado-simulador').text('Grabando… ' + Math.floor((performance.now() - inicio) / 1000) + ' s · Máximo 2 minutos.');
        }, 1000);
        temporizadorGrabacion = setTimeout(detenerGrabacionSimulador, 119000);
    } catch (error) {
        if (versionActiva === versionGrabacion) {
            limpiarAdjuntoSimulador();
            actualizarControlesSimulador();
            Swal.fire({ icon: 'error', text: error.name === 'NotAllowedError'
                ? 'Permití el acceso al micrófono para grabar audio.' : error.message || 'No se pudo acceder al micrófono.' });
        }
    } finally {
        if (versionActiva === versionGrabacion) {
            solicitandoMicrofono = false;
            actualizarControlesSimulador();
        }
    }
}

function convertirAdjuntoABase64(blob) {
    return new Promise(function leerArchivoSimulador(resolve, reject) {
        const lector = new FileReader();
        lector.onload = function resolverArchivoSimulador() { resolve(String(lector.result).split(',')[1]); };
        lector.onerror = function rechazarArchivoSimulador() { reject(new Error('No se pudo leer el archivo.')); };
        lector.readAsDataURL(blob);
    });
}

async function enviarMensajeTest() {
    const conversacion = conversacionActual;
    const contenido = $('#texto-mensaje').val().trim();
    const adjunto = adjuntoSimulador;
    const segundosEspera = Number($('#espera-simulador').val());
    const versionSimulador = conversacion?.versionSimulador || 0;
    if (conversacion?.canal !== 'simulador' || enviandoMensaje || grabadorSimulador
        || solicitandoMicrofono || reiniciandoSimulador || $('#btn-enviar-mensaje').prop('disabled') || (!contenido && !adjunto)) return;
    enviandoMensaje = true;
    actualizarControlesSimulador();
    $('#estado-simulador').text('Enviando al backend…');
    try {
        const archivo = adjunto ? {
            tipo: adjunto.tipo, mimeType: adjunto.blob.type.split(';')[0].toLowerCase(),
            base64: await convertirAdjuntoABase64(adjunto.blob), duracionSegundos: adjunto.duracionSegundos,
        } : undefined;
        if ($('body').attr('data-estado') !== 'conversacion') return;
        const resultado = await solicitarSimulador('mensajes', { contenido, segundosEspera, archivo, versionSimulador });
        if ($('body').attr('data-estado') !== 'conversacion' || !conversaciones.some(function existeChatTest(item) {
            return item._id === conversacion._id;
        })) return;
        recibirCambios(resultado);
        if (conversacionActual?._id === conversacion._id && (conversacionActual.versionSimulador || 0) === versionSimulador) {
            $('#texto-mensaje').val('');
            limpiarAdjuntoSimulador();
            $('#estado-simulador').text(resultado.mensaje.estadoBot === 'pendiente'
                ? 'Recibido. Espera de ' + segundosEspera + ' s antes de procesar. Podés enviar más mensajes.'
                : 'Recibido. Estado: ' + resultado.mensaje.estadoBot + '. Revisá las acciones del mensaje con doble clic.');
        }
    } catch (error) {
        Swal.fire({ icon: 'error', text: error.message });
    } finally {
        enviandoMensaje = false;
        $('#texto-mensaje').prop('disabled', !conversacionActual || cargandoMensajes);
        $('#btn-enviar-mensaje').prop('disabled', !conversacionActual || cargandoMensajes || !socket.connected);
        actualizarControlesSimulador();
    }
}

$('#btn-simulador').on('click', abrirSimulador);
$('#imagen-simulador').on('change', seleccionarImagenSimulador);
$('#btn-imagen-simulador').on('click', function abrirSelectorImagenSimulada() { $('#imagen-simulador').trigger('click'); });
$('#btn-grabar-simulador').on('click', alternarGrabacionSimulador);
$('#btn-limpiar-simulador').on('click', limpiarConversacionSimulador);
$('#btn-quitar-adjunto-simulador').on('click', function quitarAdjuntoSimulador() {
    limpiarAdjuntoSimulador();
    actualizarControlesSimulador();
});
window.addEventListener('pagehide', limpiarAdjuntoSimulador);
const observadorSesionSimulador = new MutationObserver(function detenerMicrofonoSinSesion() {
    if ($('body').attr('data-estado') !== 'conversacion') limpiarAdjuntoSimulador();
});
observadorSesionSimulador.observe(document.body, { attributes: true, attributeFilter: ['data-estado'] });
