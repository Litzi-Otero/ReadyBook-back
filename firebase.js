// firebase.js
const admin = require("firebase-admin");
const serviceAccount = require("../claveFirebase/serviceAccountKey.json"); 

// Inicializa la aplicación de Firebase con la cuenta de servicio
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore(); // Obtén la referencia a Firestore

module.exports = db;
