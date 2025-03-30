// controllers/UserController.js
const db = require("../firebase");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");

const createUser = async (req, res) => {
  try {
    const { name, email, age } = req.body;
    const userRef = db.collection("users").doc();

    await userRef.set({
      name,
      email,
      age,
    });

    res.status(201).json({ message: "Usuario creado correctamente" });
  } catch (error) {
    res.status(500).json({ error: "Error al crear usuario", message: error.message });
  }
};

const getUsers = async (req, res) => {
  try {
    const snapshot = await db.collection("users").get();
    const users = snapshot.docs.map(doc => ({
      id: doc.id, // Incluir el ID del documento
      ...doc.data()
    }));
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ error: "Error al obtener usuarios", message: error.message });
  }
};

const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { username, email, role } = req.body;
    console.log("Actualizando usuario ID:", id, "Datos:", { username, email, role }); // Depuración
    const userRef = db.collection("users").doc(id);

    // Verificar si el usuario existe
    const doc = await userRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    await userRef.update({
      username,
      email,
      role,
    });

    res.status(200).json({ message: "Usuario actualizado correctamente" });
  } catch (error) {
    res.status(500).json({ error: "Error al actualizar usuario", message: error.message });
  }
};

const deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    const userRef = db.collection("users").doc(id);
    const doc = await userRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }
    await userRef.delete();
    res.json({ message: "Usuario eliminado" });
  } catch (error) {
    res.status(500).json({ error: "Error al eliminar usuario", message: error.message });
  }
};

const updateProfile = async (req, res) => {
  const { email, username, password } = req.body;

  try {
    const userSnapshot = await db.collection("users").where("email", "==", email).get();
    if (userSnapshot.empty) {
      return res.status(400).json({ error: "Usuario no encontrado" });
    }

    let userId;
    userSnapshot.forEach((doc) => {
      userId = doc.id;
    });

    const mfaCode = Math.floor(100000 + Math.random() * 900000).toString();
    const mfaData = {
      code: mfaCode,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      email,
      pendingUpdate: { 
        username, 
        password: password ? await bcrypt.hash(password, 10) : undefined 
      },
    };

    await db.collection("mfa_codes").doc(email).set(mfaData);

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Código de verificación para actualizar perfil",
      text: `Tu código de verificación es: ${mfaCode}. Expira en 5 minutos.`,
    });

    res.json({ message: "Código MFA enviado al correo", email, userId });
  } catch (error) {
    console.error("Error al iniciar actualización de perfil:", error);
    res.status(500).json({ error: "Error interno en el servidor", message: error.message });
  }
};

const verifyProfileMFA = async (req, res) => {
  const { email, code } = req.body;

  try {
    const mfaDoc = await db.collection("mfa_codes").doc(email).get();
    if (!mfaDoc.exists) {
      return res.status(400).json({ error: "Código no encontrado" });
    }

    const mfaData = mfaDoc.data();
    if (mfaData.code !== code) {
      return res.status(400).json({ error: "Código incorrecto" });
    }

    if (new Date() > new Date(mfaData.expiresAt)) {
      return res.status(400).json({ error: "Código expirado" });
    }

    const userSnapshot = await db.collection("users").where("email", "==", email).get();
    let userId;
    userSnapshot.forEach((doc) => {
      userId = doc.id;
    });

    const updateData = {
      username: mfaData.pendingUpdate.username,
    };
    if (mfaData.pendingUpdate.password) {
      updateData.password = mfaData.pendingUpdate.password;
    }

    await db.collection("users").doc(userId).update(updateData);

    await db.collection("mfa_codes").doc(email).delete();

    res.json({ message: "Perfil actualizado exitosamente" });
  } catch (error) {
    console.error("Error al verificar MFA para perfil:", error);
    res.status(500).json({ error: "Error interno en el servidor", message: error.message });
  }
};

module.exports = { createUser, getUsers, updateUser, deleteUser, updateProfile, verifyProfileMFA };