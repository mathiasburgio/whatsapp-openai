const pendientes = new Map();
const procesamientosActivos = new Map();

function segundosEspera(mensaje) {
    if (mensaje?.esSimulacion && [1, 5, 10, 15, 20].includes(mensaje.segundosEsperaSimulada)) {
        return mensaje.segundosEsperaSimulada;
    }
    const segundos = Number(process.env.WAIT_BETWEEN_MESSAGES ?? 30);
    return Number.isFinite(segundos) && segundos >= 0 && segundos <= 2147483 ? segundos : 30;
}

function programar(id, cola) {
    clearTimeout(cola.temporizador);
    cola.temporizador = setTimeout(function iniciarProcesamientoProgramado() {
        if (cola.procesando || pendientes.get(id) !== cola) return;
        const proceso = procesar(id, cola);
        const activos = procesamientosActivos.get(id) || new Set();
        activos.add(proceso);
        procesamientosActivos.set(id, activos);
        function quitarProcesamientoTerminado() {
            activos.delete(proceso);
            if (!activos.size) procesamientosActivos.delete(id);
        }
        proceso.then(quitarProcesamientoTerminado, quitarProcesamientoTerminado);
    }, Math.max(0, cola.venceEn - Date.now()));
}

function agregar(mensaje, responder) {
    if (mensaje.estadoBot !== 'pendiente') return;
    const id = String(mensaje.conversacionId);
    let cola = pendientes.get(id);
    if (!cola) {
        cola = { mensajes: new Map(), version: 0, procesando: false, cancelada: false, responder };
        pendientes.set(id, cola);
    }
    const mensajeId = String(mensaje._id);
    if (cola.mensajes.has(mensajeId)) return;
    cola.mensajes.set(mensajeId, mensaje);
    cola.version++;
    cola.venceEn = Date.now() + segundosEspera(mensaje) * 1000;
    programar(id, cola);
}

async function procesar(id, cola) {
    cola.temporizador = null;
    if (cola.procesando || pendientes.get(id) !== cola) return;
    cola.procesando = true;
    const grupo = [...cola.mensajes.values()];
    const ultimo = grupo.at(-1);
    const version = cola.version;
    let conservar = false;
    try {
        await cola.responder(ultimo, grupo, {
            desdeCola: true,
            vigente: () => pendientes.get(id) === cola && cola.version === version,
            cancelada: () => cola.cancelada,
        });
        // Si llegaron más mensajes antes del envío, vuelve a responder el bloque completo.
        conservar = ultimo.estadoBot === 'pendiente' && cola.version !== version;
    } catch (error) {
        console.error('No se pudo procesar el bloque de mensajes:', error.message);
    } finally {
        cola.procesando = false;
        if (!conservar) for (const mensaje of grupo) cola.mensajes.delete(String(mensaje._id));
        if (pendientes.get(id) === cola) {
            if (cola.mensajes.size) programar(id, cola);
            else { clearTimeout(cola.temporizador); pendientes.delete(id); }
        }
    }
}

function cancelar(conversacionId) {
    const id = String(conversacionId);
    const cola = pendientes.get(id);
    if (!cola) return [];
    cola.cancelada = true;
    clearTimeout(cola.temporizador);
    pendientes.delete(id);
    return [...cola.mensajes.values()];
}

// Espera también a procesos cuya cola ya se canceló al pausar el bot.
async function cancelarYEsperarProcesamiento(conversacionId) {
    const mensajes = cancelar(conversacionId);
    await Promise.all([...(procesamientosActivos.get(String(conversacionId)) || [])]);
    return mensajes;
}

module.exports = { agregar, cancelar, segundosEspera, cancelarYEsperarProcesamiento };
