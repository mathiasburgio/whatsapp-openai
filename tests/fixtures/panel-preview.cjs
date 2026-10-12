// Panel aislado para revisar la UI. No carga .env, MongoDB, OpenAI ni WhatsApp.
const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const { detectar } = require('../../services/promociones');
async function iniciar() {
    const root = path.resolve(__dirname, '../..');
    const temporal = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-panel-preview-'));
    if (path.dirname(temporal) !== path.resolve(os.tmpdir())) throw new Error('Directorio temporal inesperado.');
    await fs.cp(path.join(root, 'prompts'), path.join(temporal, 'prompts'), { recursive: true });
    const archivo = path.join(root, 'services/prompts.js');
    const modulo = new Module(path.join(temporal, 'services/prompts.js'));
    modulo.require = createRequire(archivo);
    modulo._compile(await fs.readFile(archivo, 'utf8'), modulo.id);
    const prompts = modulo.exports;
    const entrada = { _id: '507f1f77bcf86cd799439012', conversacionId: '507f1f77bcf86cd799439011',
        contenidoOriginal: 'Más info de CORVEN XXX', contenido: 'Más info de CORVEN XXX', deClienteParaSistema: true,
        estadoProcesamiento: 'completado', fechaEmitida: new Date().toISOString() };
    const conversacion = { _id: entrada.conversacionId, nombre: 'Cliente de prueba', telefono: '5491100000000', botActivo: false,
        requiereAtencion: true, motivoDerivacion: 'Necesita confirmar precio con el vendedor.', updatedAt: '2026-01-01T00:00:00Z',
        origenPromocion: detectar(entrada, prompts.validarPromociones((await prompts.leer('promociones')).contenido)), ultimoMensaje: entrada };
    const pendientes = { _id: '507f1f77bcf86cd799439021', nombre: 'Consulta reciente', telefono: '5491100000001', updatedAt: new Date().toISOString(),
        botActivo: false, ultimoMensaje: { deClienteParaSistema: true, contenido: 'Hola' } };
    const respondida = { _id: '507f1f77bcf86cd799439031', nombre: 'Consulta respondida', telefono: '5491100000002', updatedAt: new Date().toISOString(),
        botActivo: false, ultimoMensaje: { deSistemaParaCliente: true, contenido: 'Hola' } };
    const conversaciones = [pendientes, respondida, conversacion], mensajes = [entrada];
    const app = express();
    const servidor = http.createServer(app), io = new Server(servidor);
    app.use(express.json());
    app.get('/verificar-sesion', (req, res) => res.json({ sesionActiva: true }));
    app.get('/conversaciones', (req, res) => res.json(conversaciones.filter(item => req.query.orden !== 'pendientes' || item.requiereAtencion || item.ultimoMensaje.deClienteParaSistema)));
    app.get('/mensajes', (req, res) => res.json(mensajes.filter(item => item.conversacionId === req.query.conversacionId).slice().reverse()));
    app.post('/conversaciones/:id/bot', (req, res) => {
        const actual = conversaciones.find(item => item._id === req.params.id);
        actual.botActivo = req.body.botActivo;
        io.emit('cambios', { conversacion: actual }); res.json(actual);
    });
    io.on('connection', socket => socket.on('enviar-mensaje', (datos, responder) => {
        const actual = conversaciones.find(item => item._id === datos.conversacionId);
        const existente = mensajes.find(item => item.solicitudEnvioId === datos.solicitudId);
        if (existente) return responder({ mensaje: existente });
        const mensaje = { _id: 'preview-' + mensajes.length, conversacionId: actual._id, contenido: datos.contenido,
            deSistemaParaCliente: true, respuestaAutomatica: false, solicitudEnvioId: datos.solicitudId, estadoEnvio: 'enviado',
            whatsappId: 'wamid.preview.' + mensajes.length, fechaEmitida: new Date().toISOString() };
        mensajes.push(mensaje);
        Object.assign(actual, { botActivo: false, requiereAtencion: false, motivoDerivacion: '', ultimoMensaje: mensaje, updatedAt: mensaje.fechaEmitida });
        io.emit('cambios', { conversacion: actual, mensaje }); responder({ mensaje });
    }));
    app.post('/cerrar-sesion', (req, res) => res.json({ ok: true }));
    app.get('/metricas/mes', (req, res) => res.json({ periodo: { inicio: '2026-10-01T00:00:00Z' },
        llamadasWebSearch: 2, llamadasProcesarTexto: 8, segundosProcesados: 30, tokensProcesados: 12345, imagenesProcesadas: 3,
        respuestasAutomaticas: 4, tokensEntrada: 12000, tokensSalida: 345 }));
    app.get('/prompts', async (req, res) => res.json(await prompts.listar()));
    app.post('/prompts/:id', async (req, res) => {
        try { res.json(await prompts.guardar(req.params.id, req.body.contenido, req.body.version)); }
        catch (error) { res.status(error.status || 500).json({ error: error.message }); }
    });
    app.use(express.static(path.join(root, 'public')));
    servidor.listen(0, '127.0.0.1', () => console.log('Panel de prueba: http://127.0.0.1:' + servidor.address().port));
    process.on('SIGINT', () => io.close(async () => { await fs.rm(temporal, { recursive: true, force: true }); process.exit(0); }));
}
iniciar().catch(error => { console.error(error); process.exitCode = 1; });
