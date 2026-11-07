self.addEventListener('push', function mostrarAvisoPush(evento) {
    const aviso = evento.data.json();
    evento.waitUntil(self.registration.showNotification(aviso.titulo, {
        body: aviso.cuerpo, tag: aviso.tag, data: { url: aviso.url },
    }));
});

self.addEventListener('notificationclick', function abrirIntervencion(evento) {
    evento.notification.close();
    evento.waitUntil(self.clients.openWindow(evento.notification.data.url));
});
