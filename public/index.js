let conversaciones = [];
let conversacionActual = null;
let mensajes = [];

async function iniciarSesion(){
    try{
        const resp = await $.post({
            url: "/iniciar-sesion",
            data: {email, contrasena}
        })

    }catch(error){
        console.error("Error al iniciar sesión:", error);
        //sweet alert de error
    }
}

async function cerrarSesion(){
    await $.post("/cerrar-sesion");
    conversaciones = [];
    //oculto interfaz, muestro login
}
async function obtenerConversaciones(){
    try{
        const resp = await $.get("/obtener-conversaciones");
        conversaciones = resp;
        listarConversaciones();
        return resp;
    }catch(error){
        console.error("Error al obtener conversaciones:", error);
        //sweet alert de error
    }
}
function listarConversaciones(){
    let html = "";
    conversaciones.forEach(conversacion => {
        //listar cada conversación
    });
    //mostrar en columna de conversaciones
    $("#lista-conversaciones").html(html);
    $("#lista-conversaciones .conversacion").on("click", ev=>{
        //obtengo id de conversacion
    });
    
}
function obtenerMensajes(conversacionId){
}
function listarMensajes(){

}
function enviarMensaje(){

}


//al iniciar verifico si hay sesión activa
$.get("/verificar-sesion").then(r=>{
    if(r.sesionActiva){
        //ejecuto logica de inicialización de la interfaz
    }
})