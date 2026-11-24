const { spawn } = require("child_process");
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const horariosBackup = new Set();
for (const propiedad of [
    "TIME_FIRST_BACKUP",
    "TIME_SECOND_BACKUP",
    "TIME_THIRT_BACKUP",
    "TIME_FOUR_BACKUP"
]) {
    const horario = (process.env[propiedad] || "").trim();
    if (!horario) continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)) {
        throw new Error(`${propiedad} debe tener formato HH:mm (00:00 a 23:59)`);
    }
    horariosBackup.add(horario);
}

const args = process.argv.slice(2);
const r2 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

let currentDump = null;
function fechaLog() {
    return new Intl.DateTimeFormat("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(new Date());
}

function backup() {
    let t0 = performance.now();
    return new Promise((resolve, reject) => {
        let fx = new Date().toISOString().replace(/[:.]/g, '-');
        let outputPath = path.join(__dirname, "/uploads/backups/");
        let backupName = `backup_chat_${fx}.gz`;

        //verifico si existe la URI
        if (!process.env.MONGO_URI) return reject(new Error("MONGO_URI no definida"));

        //creo la carpeta si no existe
        fs.mkdirSync(outputPath, { recursive: true });

        const args = [
            `--uri=${process.env.MONGO_URI}`,
            `--archive=${path.join(outputPath, backupName)}`,
            "--gzip"
        ];

        const command = process.platform === "win32" ? `C:\\Program Files\\MongoDB\\tools\\mongodump.exe` : "mongodump";
        const dump = spawn(command, args, { stdio: "pipe" });
        currentDump = dump;

        dump.stderr.on("data", d => console.error(d.toString()));
        dump.stdout.on("data", d => console.log(d.toString()));

        dump.on("error", code=>{
            currentDump = null;
            reject(new Error(`mongodump error: ${code?.message}`));
        });

        dump.on("close", async code => {
            currentDump = null;
            if (code !== 0) return reject(new Error(`mongodump exit code ${code}`));

            try {
                await subirBackupR2(outputPath, backupName);
                await limpiarBackupsLocales(outputPath, 5);
                let t1 = performance.now();
                console.log(`Backup OK en ${(t1 - t0).toFixed(2)} ms`);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function subirBackupR2(outputPath, zipName) {
    try{
        const stream = fs.createReadStream(path.join(outputPath, zipName));

        await r2.send(
            new PutObjectCommand({
                Bucket: process.env.R2_BACKUP_BUCKET,
                Key: zipName,
                Body: stream,
                ContentType: "application/zip",
            })
        );
        console.log(`[${fechaLog()}] Backup subido correctamente a R2: ${zipName}`);
    }catch(err){
        console.log(`[${fechaLog()}] Falló la subida del backup ${zipName} a R2:`, err.message || err);
        throw err;
    }

    try{
        await eliminarViejosBackupsR2();
    }catch(err){
        console.log(`[${fechaLog()}] El backup se subió a R2, pero falló la limpieza de backups anteriores:`, err.message || err);
        throw err;
    }
    return zipName;
}

async function eliminarViejosBackupsR2(retentionDays=10) {
    const list = await r2.send(
        new ListObjectsV2Command({
            Bucket: process.env.R2_BACKUP_BUCKET,
        })
    );
    if (!list.Contents || list.Contents.length <= retentionDays) return;

    // ordenar del más nuevo al más viejo
    const ordenados = list.Contents.sort(
        (a, b) => new Date(b.LastModified) - new Date(a.LastModified)
    );

    //
    const aBorrar = ordenados.slice(retentionDays);

    for (const obj of aBorrar) {
        //console.log("Eliminando backup viejo de R2:", obj.Key);
        await r2.send(
            new DeleteObjectCommand({
                Bucket: process.env.R2_BACKUP_BUCKET,
                Key: obj.Key,
            })
        );
    }
}

async function limpiarBackupsLocales(outputPath, maxBackups=5) {
    const files = fs.readdirSync(outputPath)
        .filter(f => f.startsWith("backup_") && f.endsWith(".gz"))
        .map(f => ({
            name: f,
            time: fs.statSync(path.join(outputPath, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);
    if (files.length <= maxBackups) return;

    const aBorrar = files.slice(maxBackups);
    for (const file of aBorrar) {
        //console.log("Eliminando backup local viejo:", file.name);
        fs.unlinkSync(path.join(outputPath, file.name));
    }
}


// Programo los horarios habilitados, sin repetir backups en el mismo horario.
let running = false;
async function ejecutarBackupProgramado() {
    if(running) return;
    running = true;
    let timeout;
    try {
        console.log("Comenzando backup...");
        await Promise.race([
            backup(),
            new Promise((_, reject) =>
                timeout = setTimeout(
                    () => {
                        if(currentDump) currentDump.kill(); //si esta corriendo mato el proceso
                        reject(new Error("Backup timeout (10min)"))
                    },
                    10 * 60 * 1000
                )
            )
        ]);
    } catch (error) {
        console.log(`[${fechaLog()}] Error al generar o completar el backup:`, error.message || error);
    } finally {
        clearTimeout(timeout);
        running = false;
    }
}

for (const horario of horariosBackup) {
    const [hora, minuto] = horario.split(":").map(Number);
    cron.schedule(`${minuto} ${hora} * * *`, ejecutarBackupProgramado, {
        scheduled: true,
        timezone: "America/Argentina/Buenos_Aires"
    });
}

if(args.includes("--now")){
    console.log("Iniciando backup inmediato...");
    backup().then(()=>{
        console.log("Backup inmediato finalizado.");
        process.exit(0);
    }).catch(err=>{
        console.log(`[${fechaLog()}] Error en backup inmediato:`, err.message || err);
        process.exit(1);
    });
}
