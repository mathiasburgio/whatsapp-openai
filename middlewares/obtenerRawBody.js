function obtenerRawBody(req, res, body) {
    req.rawBody = Buffer.from(body);
}

module.exports = obtenerRawBody;
