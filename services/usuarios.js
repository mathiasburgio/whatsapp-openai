const bcrypt = require('bcrypt');
const Usuario = require('../models/usuarios');

function normalizarEmail(email) {
    if (typeof email !== 'string') throw new Error('Debés indicar un email válido.');
    const normalizado = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizado)) {
        throw new Error('Debés indicar un email válido.');
    }
    return normalizado;
}

function validarContrasena(contrasena) {
    if (typeof contrasena !== 'string' || !contrasena.trim()) {
        throw new Error('Debés indicar una contraseña.');
    }
    // bcrypt ignora los bytes posteriores al límite de 72.
    if (Buffer.byteLength(contrasena, 'utf8') > 72) {
        throw new Error('La contraseña no puede superar los 72 bytes en UTF-8.');
    }
}

//crea un usuario, si llega contraseña la guarda/sobre-escribe. Si el usuario estaba deshabilitado lo rehabilita
async function nuevo(email, contrasena) {
    const emailNormalizado = normalizarEmail(email);
    if (contrasena !== undefined) validarContrasena(contrasena);
    const existente = await Usuario.findOne({ email: emailNormalizado });

    // Crear un usuario no cambia la contraseña de una cuenta ya habilitada.
    if (existente?.habilitado) return { email: emailNormalizado, accion: 'existente' };

    if (existente) {
        if (contrasena !== undefined) existente.contrasena = await bcrypt.hash(contrasena, 12);
        existente.habilitado = true;
        await existente.save();
        return { email: emailNormalizado, accion: 'habilitado' };
    }

    validarContrasena(contrasena);
    const hash = await bcrypt.hash(contrasena, 12);
    await Usuario.create({ email: emailNormalizado, contrasena: hash, habilitado: true });
    return { email: emailNormalizado, accion: 'creado' };
}

//sinonimo de "nuevo" (vease llama a "nuevo")
async function habilitar(email, contrasena) {
    return nuevo(email, contrasena);
}

async function deshabilitar(email) {
    const emailNormalizado = normalizarEmail(email);
    const usuario = await Usuario.findOneAndUpdate(
        { email: emailNormalizado },
        { $set: { habilitado: false } },
        { returnDocument: 'after', runValidators: true },
    );
    if (!usuario) throw new Error('No existe un usuario con ese email.');
    return { email: emailNormalizado, accion: 'deshabilitado' };
}
async function listar(req, res){
    try{
        const usuarios = await Usuario.find().select('-contrasena');
        res.json(usuarios);
    }catch(error){
        if(process.env.NODE_ENV === 'development') console.error(error);
        res.status(500).json({ error: error.message });
    }
}
async function iniciarSesion(req, res){
    try{
        const email = String(req.body?.email || '').trim().toLowerCase();
        const contrasena = String(req.body?.contrasena || '');
        const usuario = await Usuario.findOne({ email, habilitado: true }).select('+contrasena');
        if (!usuario || !await bcrypt.compare(contrasena, usuario.contrasena)) {
            return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
        }
        req.session.regenerate(error => {
            if (error) return res.status(500).json({ error: 'No se pudo iniciar sesión.' });
            req.session.usuarioId = usuario._id.toString();
            req.session.usuarioEmail = usuario.email;
            res.json({ sesionActiva: true });
        });
    }catch(error){
        if(process.env.NODE_ENV === 'development') console.error(error);
        res.status(500).json({ error: error.message });
    }
}
function cerrarSesion(req, res){
    try{
        req.session.destroy(error => {
            if (error) return res.status(500).json({ error: 'No se pudo cerrar sesión.' });
            res.clearCookie('whatsapp_openai_session');
            if(req.method === 'POST') return res.json({ sesionActiva: false });
            else return res.redirect('/');
        });
    }catch(error){
        if(process.env.NODE_ENV === 'development') console.error(error);
        res.status(500).json({ error: error.message });
    }
}

module.exports = {
    normalizarEmail,
    validarContrasena,
    nuevo,
    deshabilitar,
    iniciarSesion,
    listar,
    cerrarSesion,
    habilitar //sinonimo de "nuevo"
};

