require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const fs = require('fs');
const B2 = require('backblaze-b2');
const cors = require('cors');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

// Inicializa Firebase Admin usando las credenciales en la variable de entorno
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();

// Middleware para parsear JSON (se debe colocar antes de las rutas)
app.use(express.json());

// Configuración de CORS (permite el origen de tu frontend, ej. http://localhost:8080)
const corsOptions = {
  origin: "http://localhost:8080", // Cambia este valor si tu frontend usa otro dominio
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));

// Configura multer para almacenar archivos temporalmente en la carpeta 'uploads'
const upload = multer({ dest: 'uploads/' });

// Inicializa Backblaze B2 usando las variables de entorno
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

// Subir archivo a Backblaze B2
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
    
    // Construye la ruta del archivo en el bucket: "archivos/{uid}/{carpeta}/{nombreArchivo}"
    let refPath = "archivos/" + uid + "/";
    if (carpeta) {
      refPath += carpeta + "/";
    }
    refPath += originalFileName;

    const uploadResponse = await b2.uploadFile({
      uploadUrl,
      uploadAuthToken: authorizationToken,
      fileName: refPath,
      data: fileData,
    });

    // Elimina el archivo temporal
    fs.unlinkSync(filePath);

    res.json({ success: true, data: { fileId: uploadResponse.data.fileId, fileName: refPath } });
  } catch (error) {
    console.error("Error al subir archivo:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Listar archivos
app.get('/files', async (req, res) => {
  try {
    await b2.authorize();
    const bucketId = process.env.B2_BUCKET_ID;
    const uid = req.query.uid ? req.query.uid.trim() : "";
    let prefix = "archivos/";
    if (uid) {
      prefix += uid + "/";
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

// Eliminar archivo
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

// Generar URL de descarga (archivo firmado)
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

// Enviar notificaciones por correo
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
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

// Inicia el servidor en el puerto definido por la variable de entorno PORT o en 3000 por defecto
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
