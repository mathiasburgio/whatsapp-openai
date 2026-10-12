const { rateLimit } = require('express-rate-limit');

function createRateLimit(windowMs = 15 * 60 * 1000, limit = 5,
    message = { error: 'Demasiados intentos. Volvé a intentar más tarde.' }) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message,
    });
}

module.exports = createRateLimit;
