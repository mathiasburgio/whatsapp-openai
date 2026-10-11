const mongoose = require('mongoose');

const usuarioSchema = new mongoose.Schema({
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    contrasena: { type: String, required: true, select: false },
    habilitado: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Usuario', usuarioSchema, 'usuarios');
