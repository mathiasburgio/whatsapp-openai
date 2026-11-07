const token = new URLSearchParams(location.search).get('token');
const estado = document.getElementById('estado');
const confirmar = document.getElementById('confirmar');
let registro;
let clavePublica;

async function prepararAdhesion() {
    try {
        if (!token) throw new Error('Falta el token de invitación. Pedí el enlace al administrador.');
        if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
            throw new Error('Abrí el enlace por HTTPS en un navegador compatible con notificaciones. En iPhone, agregá primero esta página a la pantalla de inicio y abrila desde allí.');
        }
        const respuesta = await fetch(`/notificaciones/invitaciones/${encodeURIComponent(token)}`);
        const datos = await respuesta.json();
        if (!respuesta.ok) throw new Error(datos.error);
        clavePublica = datos.publicKey;
        await navigator.serviceWorker.register('/notificaciones-sw.js');
        registro = await navigator.serviceWorker.ready;
        estado.textContent = `Invitación válida hasta las ${new Date(datos.venceEn).toLocaleTimeString()}.`;
        confirmar.disabled = false;
    } catch (error) {
        estado.textContent = error.message;
    }
}

async function confirmarAdhesion() {
    confirmar.disabled = true;
    try {
        // Pedir permiso directamente desde el clic conserva el gesto requerido por el navegador.
        const permiso = await Notification.requestPermission();
        if (permiso !== 'granted') throw new Error('No se habilitaron las notificaciones. Podés permitirlas desde la configuración del navegador y volver a confirmar.');
        const suscripcion = await registro.pushManager.getSubscription()
            || await registro.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: clavePublica });
        const respuesta = await fetch('/notificaciones/suscripciones', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, suscripcion }) });
        const datos = await respuesta.json();
        if (!respuesta.ok) {
            if (respuesta.status === 410) confirmar.hidden = true;
            throw new Error(datos.error);
        }
        estado.textContent = 'Listo. Vas a recibir avisos cuando se necesite tu intervención. Podés cerrar esta página.';
        confirmar.hidden = true;
    } catch (error) {
        estado.textContent = error.message;
        confirmar.disabled = false;
    }
}

confirmar.addEventListener('click', confirmarAdhesion);
prepararAdhesion();
