const mongoose = require("mongoose");
let dbConnection;

async function connectDB(){
	if (!process.env.MONGO_URI) throw new Error('Falta definir MONGO_URI.');
	 try{
		if(dbConnection && mongoose.connection.readyState === 1) return dbConnection;
			dbConnection = await mongoose.connect(process.env.MONGO_URI, {
			})
			console.log('MongoDB connected successfully');
		 return dbConnection;
	}catch(error){
		throw new Error('No fue posible conectar con MongoDB. Revisá MONGO_URI y la disponibilidad del servidor.', { cause: error });
	}
}

async function disconnectDB() {
    await mongoose.disconnect();
    dbConnection = null;
}

const checkDatabase = (req, res, next) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({
            error: "Database not ready"
        });
    }
    next();
};

module.exports = { connectDB, disconnectDB, checkDatabase };
