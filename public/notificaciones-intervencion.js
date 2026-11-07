async function cargarIntervencion() {
    const estado = document.getElementById('estado');
    try {
        const respuesta = await fetch(`${location.pathname}/datos`);
        const datos = await respuesta.json();
        if (!respuesta.ok) throw new Error(datos.error);
        const { conversacion, mensajes, accionId } = datos;
        document.getElementById('contacto').textContent = conversacion.nombre || conversacion.telefono;
        document.getElementById('telefono').textContent = conversacion.telefono;
        document.getElementById('resumen').textContent = conversacion.resumen || 'Todavía no hay un resumen generado. Revisá los items pendientes y los mensajes.';
        const numero = (conversacion.telefono || '').replace(/\D/g, '');
        const enviar = document.getElementById('enviar');
        enviar.href = `https://wa.me/${numero}`;
        enviar.hidden = !numero;
        const pendientes = conversacion.accionesExternasRequeridas.filter(accion => !accion.aceptada || accion._id === accionId);
        const lista = document.getElementById('pendientes');
        for (const accion of pendientes) {
            const item = document.createElement('li');
            item.className = accion.aceptada ? '' : 'pendiente';
            if (accion._id === accionId) item.classList.add('seleccionada');
            item.textContent = `${accion.aceptada ? 'Atendida' : 'Pendiente'}: ${accion.detalle}`;
            lista.appendChild(item);
        }
        if (!pendientes.length) lista.textContent = 'No hay intervenciones pendientes.';
        const contenedor = document.getElementById('mensajes');
        for (const mensaje of mensajes) {
            const articulo = document.createElement('article');
            const cabecera = document.createElement('header');
            const autor = document.createElement('strong');
            const fecha = document.createElement('time');
            const texto = document.createElement('p');
            autor.textContent = mensaje.deClienteParaSistema ? 'Cliente' : mensaje.respuestaAutomatica ? 'Bot' : 'Vendedor';
            const momento = new Date(mensaje.fechaEmitida || mensaje.createdAt);
            fecha.dateTime = momento.toISOString();
            fecha.textContent = momento.toLocaleString();
            texto.textContent = mensaje.contenido || '[Archivo sin texto]';
            if (!mensaje.deClienteParaSistema) articulo.classList.add('enviado');
            if (pendientes.some(accion => accion._id === mensaje._id && !accion.aceptada)) {
                articulo.classList.add('requiere-intervencion');
                const marca = document.createElement('p');
                marca.textContent = 'Requiere intervención';
                articulo.appendChild(marca);
            }
            cabecera.append(autor, fecha);
            articulo.append(cabecera, texto);
            contenedor.appendChild(articulo);
        }
        if (!mensajes.length) contenedor.textContent = 'No hay mensajes guardados.';
        document.getElementById('intervencion').hidden = false;
        estado.textContent = '';
    } catch (error) {
        estado.textContent = error.message;
    }
}

cargarIntervencion();
