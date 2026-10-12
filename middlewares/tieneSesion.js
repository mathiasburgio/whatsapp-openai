const Usuario = require('../models/usuarios');

async function tieneSesion(req, res, next) {
    try {
        if (!req.session?.usuarioId || !await Usuario.exists({ _id: req.session.usuarioId, habilitado: true })) {
            return res.status(401).json({ error: 'Iniciá sesión para continuar.' });
        }
        next();
    } catch (error) {
        next(error);
    }
}

module.exports = tieneSesion;
