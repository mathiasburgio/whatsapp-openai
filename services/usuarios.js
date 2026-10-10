function nuevo(){

}
function deshabilitar(){

}
function listar(req, res){
    try{

    }catch(error){
        if(process.env.NODE_ENV === 'development') console.error(error);
        res.status(500).json({ error: error.message });
    }
}
function iniciarSesion(req, res){
    try{

    }catch(error){
        if(process.env.NODE_ENV === 'development') console.error(error);
        res.status(500).json({ error: error.message });
    }
}
function cerrarSesion(req, res){
    try{

    }catch(error){
        if(process.env.NODE_ENV === 'development') console.error(error);
        res.status(500).json({ error: error.message });
    }
}

module.exports = {
    nuevo,
    deshabilitar,
    iniciarSesion,
    listar,
    cerrarSesion
};


