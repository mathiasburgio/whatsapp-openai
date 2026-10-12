const session = require('express-session');

const middlewareSesion = session({
    name: 'whatsapp_openai_session',
    secret: process.env.SESSION_SECRET || 'default_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000,
    },
});

module.exports = middlewareSesion;
