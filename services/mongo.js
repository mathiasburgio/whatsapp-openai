const mongoose = require("mongoose");
let dbConnection;

async function connectDB(){
	 //'mongodb://127.0.0.1/exampleDB'
	 try{
		if(dbConnection) return dbConnection;
			dbConnection = await mongoose.connect(process.env.MONGO_URI, {
			})
			console.log('MongoDB connected successfully');
		 return dbConnection;
	}catch(error){
		if(process.env.NODE_ENV === "development") console.error('Error connecting to MongoDB:', error.message);
		process.exit(1);
	}
}


const checkDatabase = (req, res, next) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({
            error: "Database not ready"
        });
    }
    next();
};

module.exports = { connectDB, checkDatabase };
