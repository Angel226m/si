/* require('dotenv').config(); // Carga las variables de entorno del archivo .env
const express = require('express');
const multer  = require('multer');
const fs = require('fs');
const B2 = require('backblaze-b2');

const app = express();

// Middleware para parsear JSON (necesario para POST /folder)
app.use(express.json());

// Middleware CORS para permitir solicitudes desde el front-end
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // Puedes restringir a http://localhost:8080 si lo prefieres
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// Configura multer para almacenar archivos temporalmente en la carpeta 'uploads'
const upload = multer({ dest: 'uploads/' });

// Inicializa Backblaze B2 con tus credenciales (desde el archivo .env)
const b2 = new B2({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
});

// ----- Endpoints para Carpetas ----- //

// Almacenamiento en memoria para carpetas (para persistir, usa una base de datos)
const folders = [];
let folderIdCounter = 1;

// Endpoint para crear una carpeta (POST /folder)
// Ahora se requiere enviar { name, uid } para asociar la carpeta al usuario.
app.post('/folder', (req, res) => {
  const { name, uid } = req.body;
  if (!name || !uid) {
    return res.status(400).json({ success: false, error: "Falta el nombre de la carpeta o el UID" });
  }
  const newFolder = { id: folderIdCounter++, name, uid };
  folders.push(newFolder);
  res.json({ success: true, data: newFolder });
});

// Endpoint para obtener la lista de carpetas (GET /folders?uid=...)
// Se retorna solo las carpetas asociadas al usuario autenticado.
app.get('/folders', (req, res) => {
  const uid = req.query.uid ? req.query.uid.trim() : "";
  if (!uid) {
    return res.status(400).json({ success: false, error: "Falta el UID en la query" });
  }
  const userFolders = folders.filter(folder => folder.uid === uid);
  res.json({ success: true, folders: userFolders });
});

// ----- Endpoints para Archivos ----- //

// Endpoint para subir un archivo a Backblaze B2, asociándolo a un UID y una carpeta (si se envía)
app.post('/upload', upload.single('archivo'), async (req, res) => {
  try {
    // Se requiere el UID del usuario
    const uid = req.body.uid ? req.body.uid.trim() : "";
    if (!uid) {
      return res.status(400).json({ success: false, error: "UID requerido" });
    }
    await b2.authorize();
    const bucketId = process.env.B2_BUCKET_ID;
    const uploadUrlResponse = await b2.getUploadUrl({ bucketId });
    const { uploadUrl, authorizationToken } = uploadUrlResponse.data;

    const filePath = req.file.path;
    const fileData = fs.readFileSync(filePath);
    const originalFileName = req.file.originalname;

    // Construir la ruta: "archivos/{uid}/{carpeta}/{nombreArchivo}"
    const carpeta = req.body.carpeta ? req.body.carpeta.trim() : "";
    let refPath = "archivos/";
    refPath += `${uid}/`;
    if (carpeta) {
      refPath += `${carpeta}/`;
    }
    refPath += originalFileName;

    const uploadResponse = await b2.uploadFile({
      uploadUrl,
      uploadAuthToken: authorizationToken,
      fileName: refPath,
      data: fileData,
    });

    // Se elimina el archivo temporal
    fs.unlinkSync(filePath);

    // Devuelve fileId y refPath para su uso posterior
    res.json({ success: true, data: { fileId: uploadResponse.data.fileId, fileName: refPath } });
  } catch (error) {
    console.error("Error al subir archivo:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para listar archivos filtrados por UID (GET /files?uid=...)
app.get('/files', async (req, res) => {
  try {
    await b2.authorize();
    const bucketId = process.env.B2_BUCKET_ID;
    const uid = req.query.uid ? req.query.uid.trim() : "";
    let prefix = "archivos/";
    if (uid) {
      prefix += `${uid}/`;
    }
    const listResponse = await b2.listFileNames({
      bucketId,
      prefix,
      maxFileCount: 100,
    });
    res.json({ success: true, files: listResponse.data.files });
  } catch (error) {
    console.error("Error al listar archivos:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para eliminar un archivo, verificando que pertenezca al usuario (DELETE /file?uid=...&fileId=...&fileName=...)
app.delete('/file', async (req, res) => {
  try {
    const { fileId, fileName, uid } = req.query;
    if (!fileId || !fileName || !uid) {
      return res.status(400).json({ success: false, error: "Se requiere fileId, fileName y uid" });
    }
    // Se verifica que la ruta del archivo incluya el UID
    if (!fileName.startsWith(`archivos/${uid}/`)) {
      return res.status(403).json({ success: false, error: "No autorizado para eliminar este archivo" });
    }
    await b2.authorize();
    const deleteResponse = await b2.deleteFileVersion({ fileId, fileName });
    res.json({ success: true, data: deleteResponse.data });
  } catch (error) {
    console.error("Error al eliminar archivo:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para generar una URL firmada para descargar un archivo, verificando que pertenezca al usuario (GET /download?uid=...&fileName=...)
app.get('/download', async (req, res) => {
  const fileName = req.query.fileName; // Ejemplo: "archivos/{uid}/{carpeta}/{archivo}"
  const uid = req.query.uid ? req.query.uid.trim() : "";
  if (!fileName || !uid) {
    return res.status(400).json({ success: false, error: "Falta el parámetro fileName o uid" });
  }
  // Se verifica que el archivo pertenezca al usuario
  if (!fileName.startsWith(`archivos/${uid}/`)) {
    return res.status(403).json({ success: false, error: "No autorizado para descargar este archivo" });
  }
  try {
    const authResponse = await b2.authorize();
    const bucketId = process.env.B2_BUCKET_ID;
    const validDurationInSeconds = 3600; // URL válida por 1 hora
    const downloadAuthResponse = await b2.getDownloadAuthorization({
      bucketId,
      fileNamePrefix: fileName,
      validDurationInSeconds,
    });
    const token = downloadAuthResponse.data.authorizationToken;
    const baseDownloadUrl = authResponse.data.downloadUrl;
    const bucketName = process.env.B2_BUCKET_NAME;
    const signedUrl = `${baseDownloadUrl}/file/${bucketName}/${fileName}?Authorization=${token}`;
    res.json({ success: true, signedUrl });
  } catch (error) {
    console.error("Error al generar URL de descarga:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));





  */

      require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const fs = require('fs');
const B2 = require('backblaze-b2');
const cors = require('cors');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

// Inicializa Firebase Admin usando las credenciales almacenadas en la variable de entorno FIREBASE_CREDENTIALS
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();

// Middleware para parsear JSON (debe ir antes de las rutas)
app.use(express.json());

// Configuración de CORS: Permite el origen del frontend (puedes usar "*" para permitir cualquier origen, pero es más seguro especificar el dominio)
const corsOptions = {
  origin: "http://localhost:8080", // Cambia este valor al origen que necesites
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));

// Configura multer para almacenar archivos temporalmente en la carpeta 'uploads'
const upload = multer({ dest: 'uploads/' });

// Inicializa Backblaze B2 con las credenciales de las variables de entorno
const b2 = new B2({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
});

// ----- Endpoints para Carpetas -----
const folders = [];
let folderIdCounter = 1;

app.post('/folder', (req, res) => {
  const { name, uid } = req.body;
  if (!name || !uid) {
    return res.status(400).json({ success: false, error: "Falta el nombre de la carpeta o el UID" });
  }
  const newFolder = { id: folderIdCounter++, name, uid };
  folders.push(newFolder);
  res.json({ success: true, data: newFolder });
});

app.get('/folders', (req, res) => {
  const uid = req.query.uid ? req.query.uid.trim() : "";
  if (!uid) {
    return res.status(400).json({ success: false, error: "Falta el UID en la query" });
  }
  const userFolders = folders.filter(folder => folder.uid === uid);
  res.json({ success: true, folders: userFolders });
});

// ----- Endpoints para Archivos -----
app.post('/upload', upload.single('archivo'), async (req, res) => {
  try {
    const uid = req.body.uid ? req.body.uid.trim() : "";
    if (!uid) {
      return res.status(400).json({ success: false, error: "UID requerido" });
    }
    await b2.authorize();
    const bucketId = process.env.B2_BUCKET_ID;
    const uploadUrlResponse = await b2.getUploadUrl({ bucketId });
    const { uploadUrl, authorizationToken } = uploadUrlResponse.data;

    const filePath = req.file.path;
    const fileData = fs.readFileSync(filePath);
    const originalFileName = req.file.originalname;

    const carpeta = req.body.carpeta ? req.body.carpeta.trim() : "";
    let refPath = "archivos/";
    refPath += `${uid}/`;
    if (carpeta) {
      refPath += `${carpeta}/`;
    }
    refPath += originalFileName;

    const uploadResponse = await b2.uploadFile({
      uploadUrl,
      uploadAuthToken: authorizationToken,
      fileName: refPath,
      data: fileData,
    });

    fs.unlinkSync(filePath);

    res.json({ success: true, data: { fileId: uploadResponse.data.fileId, fileName: refPath } });
  } catch (error) {
    console.error("Error al subir archivo:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/files', async (req, res) => {
  try {
    await b2.authorize();
    const bucketId = process.env.B2_BUCKET_ID;
    const uid = req.query.uid ? req.query.uid.trim() : "";
    let prefix = "archivos/";
    if (uid) {
      prefix += `${uid}/`;
    }
    const listResponse = await b2.listFileNames({
      bucketId,
      prefix,
      maxFileCount: 100,
    });
    res.json({ success: true, files: listResponse.data.files });
  } catch (error) {
    console.error("Error al listar archivos:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/file', async (req, res) => {
  try {
    const { fileId, fileName, uid } = req.query;
    if (!fileId || !fileName || !uid) {
      return res.status(400).json({ success: false, error: "Se requiere fileId, fileName y uid" });
    }
    if (!fileName.startsWith(`archivos/${uid}/`)) {
      return res.status(403).json({ success: false, error: "No autorizado para eliminar este archivo" });
    }
    await b2.authorize();
    const deleteResponse = await b2.deleteFileVersion({ fileId, fileName });
    res.json({ success: true, data: deleteResponse.data });
  } catch (error) {
    console.error("Error al eliminar archivo:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/download', async (req, res) => {
  const fileName = req.query.fileName;
  const uid = req.query.uid ? req.query.uid.trim() : "";
  if (!fileName || !uid) {
    return res.status(400).json({ success: false, error: "Falta el parámetro fileName o uid" });
  }
  if (!fileName.startsWith(`archivos/${uid}/`)) {
    return res.status(403).json({ success: false, error: "No autorizado para descargar este archivo" });
  }
  try {
    const authResponse = await b2.authorize();
    const bucketId = process.env.B2_BUCKET_ID;
    const validDurationInSeconds = 3600;
    const downloadAuthResponse = await b2.getDownloadAuthorization({
      bucketId,
      fileNamePrefix: fileName,
      validDurationInSeconds,
    });
    const token = downloadAuthResponse.data.authorizationToken;
    const baseDownloadUrl = authResponse.data.downloadUrl;
    const bucketName = process.env.B2_BUCKET_NAME;
    const signedUrl = `${baseDownloadUrl}/file/${bucketName}/${fileName}?Authorization=${token}`;
    res.json({ success: true, signedUrl });
  } catch (error) {
    console.error("Error al generar URL de descarga:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----- Endpoint para Enviar Notificaciones por Correo -----
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,   // Ejemplo: tu-correo@gmail.com
    pass: process.env.EMAIL_PASS,   // Tu clave de aplicación
  },
});

app.post('/send-notification', async (req, res) => {
  const { to, subject, text, html } = req.body;
  if (!to || !subject || (!text && !html)) {
    return res.status(400).json({ success: false, error: 'Faltan datos para enviar el correo' });
  }
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text,
      html,
    });
    res.json({ success: true, message: 'Correo enviado', info });
  } catch (error) {
    console.error("Error al enviar notificación:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Arranca el servidor usando el puerto asignado por Render o el 3000 en local
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));

/*
require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const fs = require('fs');
const B2 = require('backblaze-b2');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

// -------------------- Configuración de Firebase Admin --------------------
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // Coloca este archivo en la ruta correcta

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const dbAdmin = admin.firestore();
// ---------------------------------------------------------------------------

const app = express();

// Middleware para parsear JSON y habilitar CORS para todas las rutas
app.use(express.json());
app.use(cors());

// Configura multer para almacenar archivos temporalmente en 'uploads'
const upload = multer({ dest: 'uploads/' });

// Inicializa Backblaze B2 con tus credenciales (definidas en el .env)
const b2 = new B2({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
});

// --------------------- Endpoints para Carpetas ---------------------
const folders = [];
let folderIdCounter = 1;

app.post('/folder', (req, res) => {
  const { name, uid } = req.body;
  if (!name || !uid) {
    return res.status(400).json({ success: false, error: "Falta el nombre de la carpeta o el UID" });
  }
  const newFolder = { id: folderIdCounter++, name, uid };
  folders.push(newFolder);
  res.json({ success: true, data: newFolder });
});

app.get('/folders', (req, res) => {
  const uid = req.query.uid ? req.query.uid.trim() : "";
  if (!uid) {
    return res.status(400).json({ success: false, error: "Falta el UID en la query" });
  }
  const userFolders = folders.filter(folder => folder.uid === uid);
  res.json({ success: true, folders: userFolders });
});

// --------------------- Endpoints para Archivos ---------------------
app.post('/upload', upload.single('archivo'), async (req, res) => {
  try {
    const uid = req.body.uid ? req.body.uid.trim() : "";
    if (!uid) {
      return res.status(400).json({ success: false, error: "UID requerido" });
    }
    await b2.authorize();
    const bucketId = process.env.B2_BUCKET_ID;
    const uploadUrlResponse = await b2.getUploadUrl({ bucketId });
    const { uploadUrl, authorizationToken } = uploadUrlResponse.data;

    const filePath = req.file.path;
    const fileData = fs.readFileSync(filePath);
    const originalFileName = req.file.originalname;

    const carpeta = req.body.carpeta ? req.body.carpeta.trim() : "";
    let refPath = "archivos/";
    refPath += `${uid}/`;
    if (carpeta) {
      refPath += `${carpeta}/`;
    }
    refPath += originalFileName;

    const uploadResponse = await b2.uploadFile({
      uploadUrl,
      uploadAuthToken: authorizationToken,
      fileName: refPath,
      data: fileData,
    });

    fs.unlinkSync(filePath);

    res.json({ success: true, data: { fileId: uploadResponse.data.fileId, fileName: refPath } });
  } catch (error) {
    console.error("Error al subir archivo:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/files', async (req, res) => {
  try {
    await b2.authorize();
    const bucketId = process.env.B2_BUCKET_ID;
    const uid = req.query.uid ? req.query.uid.trim() : "";
    let prefix = "archivos/";
    if (uid) {
      prefix += `${uid}/`;
    }
    const listResponse = await b2.listFileNames({
      bucketId,
      prefix,
      maxFileCount: 100,
    });
    res.json({ success: true, files: listResponse.data.files });
  } catch (error) {
    console.error("Error al listar archivos:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/file', async (req, res) => {
  try {
    const { fileId, fileName, uid } = req.query;
    if (!fileId || !fileName || !uid) {
      return res.status(400).json({ success: false, error: "Se requiere fileId, fileName y uid" });
    }
    if (!fileName.startsWith(`archivos/${uid}/`)) {
      return res.status(403).json({ success: false, error: "No autorizado para eliminar este archivo" });
    }
    await b2.authorize();
    const deleteResponse = await b2.deleteFileVersion({ fileId, fileName });
    res.json({ success: true, data: deleteResponse.data });
  } catch (error) {
    console.error("Error al eliminar archivo:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/download', async (req, res) => {
  const fileName = req.query.fileName;
  const uid = req.query.uid ? req.query.uid.trim() : "";
  if (!fileName || !uid) {
    return res.status(400).json({ success: false, error: "Falta el parámetro fileName o uid" });
  }
  if (!fileName.startsWith(`archivos/${uid}/`)) {
    return res.status(403).json({ success: false, error: "No autorizado para descargar este archivo" });
  }
  try {
    const authResponse = await b2.authorize();
    const bucketId = process.env.B2_BUCKET_ID;
    const validDurationInSeconds = 3600;
    const downloadAuthResponse = await b2.getDownloadAuthorization({
      bucketId,
      fileNamePrefix: fileName,
      validDurationInSeconds,
    });
    const token = downloadAuthResponse.data.authorizationToken;
    const baseDownloadUrl = authResponse.data.downloadUrl;
    const bucketName = process.env.B2_BUCKET_NAME;
    const signedUrl = `${baseDownloadUrl}/file/${bucketName}/${fileName}?Authorization=${token}`;
    res.json({ success: true, signedUrl });
  } catch (error) {
    console.error("Error al generar URL de descarga:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --------------------- Endpoint para Enviar Notificaciones por Correo ---------------------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,   // Ej.: angelgarayt22@gmail.com
    pass: process.env.EMAIL_PASS,   // Tu contraseña de aplicación
  },
});

app.post('/send-notification', async (req, res) => {
  const { to, subject, text, html } = req.body;
  if (!to || !subject || (!text && !html)) {
    return res.status(400).json({ success: false, error: 'Faltan datos para enviar el correo' });
  }
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text,
      html,
    });
    res.json({ success: true, message: 'Correo enviado', info });
  } catch (error) {
    console.error("Error al enviar notificación:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --------------------- Tarea Programada: Enviar Notificaciones 5 Minutos Antes ---------------------
// Esta función consulta la colección "eventos" en Firestore y, si algún evento inicia en los próximos 5 minutos, envía un correo.
const checkUpcomingEvents = async () => {
  try {
    const ahora = new Date();
    const cincoMinutosDespues = new Date(ahora.getTime() + 5 * 60 * 1000);
    
    // Consulta todos los eventos de la colección "eventos" en Firestore
    const snapshot = await dbAdmin.collection("eventos").get();
    snapshot.forEach(async (doc) => {
      const evento = doc.data();
      // Se asume que el evento tiene 'start' (YYYY-MM-DD) y 'time' (HH:MM)
      const eventDateTime = new Date(`${evento.start}T${evento.time}:00`);
      
      // Si el evento comienza entre ahora y 5 minutos después
      if (eventDateTime >= ahora && eventDateTime <= cincoMinutosDespues) {
        let email = evento.email; // Intenta usar el email almacenado en el evento
        // Si no existe el campo email, obtenlo del usuario usando el UID almacenado (userId)
        if (!email && evento.userId) {
          try {
            const userRecord = await admin.auth().getUser(evento.userId);
            email = userRecord.email;
          } catch (err) {
            console.error(`Error obteniendo el usuario para el evento "${evento.title}":`, err);
            return; // Si falla, omite enviar la notificación para este evento
          }
        }
        if (!email) {
          console.error(`No se encontró email para el evento "${evento.title}"`);
          return;
        }
        
        const subject = `Recordatorio: El evento "${evento.title}" inicia en 5 minutos`;
        const text = `El evento "${evento.title}" comenzará el ${evento.start} a las ${evento.time}.`;
        const html = `<p>El evento <strong>${evento.title}</strong> comenzará el <strong>${evento.start}</strong> a las <strong>${evento.time}</strong>.</p>`;
        
        transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: email,
          subject,
          text,
          html,
        }, (err, info) => {
          if (err) {
            console.error(`Error enviando notificación para el evento "${evento.title}":`, err);
          } else {
            console.log(`Notificación enviada para el evento "${evento.title}" a ${email}`);
          }
        });
      }
    });
  } catch (error) {
    console.error("Error al revisar eventos próximos:", error);
  }
};


// Programa la tarea para que se ejecute cada minuto
cron.schedule('* * * * *', checkUpcomingEvents);

// -------------------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));*/
