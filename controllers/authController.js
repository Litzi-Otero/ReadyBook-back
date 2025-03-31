require("dotenv").config(); // Carga las variables de entorno desde .env
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../firebase");
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
const nodemailer = require("nodemailer"); // Aseguro la importación de nodemailer

const SECRET_KEY = process.env.JWT_SECRET;

// Registrar un nuevo usuario
// Registrar un nuevo usuario (versión modificada)
const registerUser = async (req, res) => {
  const { username, email, password, temp } = req.body;

  try {
    const userSnapshot = await db.collection("users").where("email", "==", email).get();
    if (!userSnapshot.empty) {
      return res.status(400).json({ error: "El correo ya está registrado" });
    }

    const secret = speakeasy.generateSecret({ name: `EventApp (${email})` });
    const otpauthUrl = speakeasy.otpauthURL({
      secret: secret.base32,
      label: `EventApp (${email})`,
      issuer: "EventApp",
      encoding: "base32",
    });
    const qrDataURL = await qrcode.toDataURL(otpauthUrl);

    if (temp) {
      // Store temporary user data
      await db.collection("temp_users").doc(email).set({
        username,
        email,
        password,
        mfaSecret: secret.base32,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 min expiration
      });

      res.status(200).json({
        message: "Configura MFA para completar el registro",
        email,
        qr: qrDataURL,
      });
    }
  } catch (error) {
    console.error("Error al iniciar registro:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor" });
  }
};

// Verificar MFA (modificado para completar registro)
const verifyRegisterMFA = async (req, res) => {
  const { email, code, username, password, completeRegistration } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: "Email y código son requeridos" });
  }

  try {
    if (completeRegistration) {
      const tempUserDoc = await db.collection("temp_users").doc(email).get();
      if (!tempUserDoc.exists) {
        return res.status(400).json({ error: "Registro temporal no encontrado o expirado" });
      }

      const tempUser = tempUserDoc.data();
      if (new Date() > new Date(tempUser.expiresAt)) {
        await db.collection("temp_users").doc(email).delete();
        return res.status(400).json({ error: "El tiempo para verificar ha expirado" });
      }

      const verified = speakeasy.totp.verify({
        secret: tempUser.mfaSecret,
        encoding: "base32",
        token: code,
        window: 1,
      });

      if (!verified) {
        return res.status(401).json({ error: "Código MFA incorrecto" });
      }

      // Only now do we actually register the user
      const hashedPassword = await bcrypt.hash(password || tempUser.password, 10);
      const userRef = await db.collection("users").add({
        username: username || tempUser.username,
        email,
        password: hashedPassword,
        role: "cliente",
        mfaSecret: tempUser.mfaSecret,
        createdAt: new Date(),
      });

      // Clean up temporary data
      await db.collection("temp_users").doc(email).delete();

      res.json({
        message: "Registro completado exitosamente",
        email,
        username: username || tempUser.username,
        userId: userRef.id,
      });
    } else {
      // Existing MFA verification logic for login
      // ... (keep original verifyMFA code here)
    }
  } catch (error) {
    console.error("Error en la verificación MFA:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor" });
  }
};

// Iniciar sesión con MFA basado en TOTP
const loginUser = async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ error: "Todos los campos son obligatorios" });
    }

    const userSnapshot = await db.collection("users").where("email", "==", email).get();
    if (userSnapshot.empty) {
      return res.status(400).json({ error: "Credenciales incorrectas" });
    }

    let user;
    userSnapshot.forEach((doc) => {
      user = { id: doc.id, ...doc.data() };
    });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Credenciales incorrectas" });
    }

    if (!user.mfaSecret || user.mfaSecret.trim() === "") {
      return res.status(400).json({ error: "MFA no configurado para este usuario" });
    }

    res.status(200).json({
      message: "Se requiere verificación MFA",
      mfaRequired: true,
      email: user.email,
      username: user.username,
      userId: user.id,
    });
  } catch (error) {
    console.error("Error en login:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor", message: error.message });
  }
};

// Verificar MFA con TOTP
const verifyMFA = async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: "Email y código son requeridos" });
  }

  try {
    const userSnapshot = await db.collection("users").where("email", "==", email).get();
    if (userSnapshot.empty) {
      return res.status(400).json({ error: "Usuario no encontrado" });
    }

    let user;
    userSnapshot.forEach((doc) => {
      user = { id: doc.id, ...doc.data() };
    });

    if (!user.mfaSecret || user.mfaSecret.trim() === "") {
      return res.status(400).json({ error: "MFA no configurado para este usuario" });
    }

    const verified = speakeasy.totp.verify({
      secret: user.mfaSecret,
      encoding: "base32",
      token: code,
      window: 1,
    });

    if (!verified) {
      return res.status(401).json({ error: "Código MFA incorrecto" });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, username: user.username },
      SECRET_KEY,
      { expiresIn: "1h" }
    );

    res.json({
      message: "Autenticación MFA exitosa",
      token,
      email: user.email,
      username: user.username,
      role: user.role,
      userId: user.id,
    });
  } catch (error) {
    console.error("Error en la verificación MFA:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor", message: error.message });
  }
};

// Solicitar recuperación de contraseña
const requestPasswordReset = async (req, res) => {
  const { email } = req.body;

  try {
    console.log("Solicitando recuperación para:", email);
    const userSnapshot = await db.collection("users").where("email", "==", email).get();
    if (userSnapshot.empty) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    let user;
    userSnapshot.forEach((doc) => {
      user = { id: doc.id, ...doc.data() };
    });
    console.log("Usuario encontrado:", user.email);

    const mfaCode = Math.floor(100000 + Math.random() * 900000).toString();
    const mfaData = {
      code: mfaCode,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      email: user.email,
      type: "password_reset",
    };

    await db.collection("mfa_codes").doc(email).set(mfaData);
    console.log("Código MFA guardado:", mfaCode);

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    console.log("Enviando email desde:", process.env.EMAIL_USER);
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: "Código de recuperación de contraseña",
      text: `Tu código para restablecer la contraseña es: ${mfaCode}. Expira en 5 minutos.`,
    });
    console.log("Email enviado exitosamente");

    res.json({
      message: "Código de recuperación enviado al correo",
      email: user.email,
    });
  } catch (error) {
    console.error("Error en recuperación de contraseña:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor", message: error.message });
  }
};

// Restablecer contraseña
const resetPassword = async (req, res) => {
  const { email, code, newPassword } = req.body;

  try {
    const mfaDoc = await db.collection("mfa_codes").doc(email).get();

    if (!mfaDoc.exists) {
      return res.status(400).json({ error: "Código no encontrado" });
    }

    const mfaData = mfaDoc.data();
    if (mfaData.type !== "password_reset" || mfaData.code !== code) {
      return res.status(400).json({ error: "Código incorrecto" });
    }

    if (new Date() > new Date(mfaData.expiresAt)) {
      return res.status(400).json({ error: "Código expirado" });
    }

    const userSnapshot = await db.collection("users").where("email", "==", email).get();
    let userId;
    userSnapshot.forEach((doc) => (userId = doc.id));

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.collection("users").doc(userId).update({
      password: hashedPassword,
      updatedAt: new Date(),
    });

    await db.collection("mfa_codes").doc(email).delete();

    res.json({ message: "Contraseña restablecida exitosamente" });
  } catch (error) {
    console.error("Error al restablecer contraseña:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor", message: error.message });
  }
};

const requestMFAQRTempCode = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email es requerido" });
  }

  try {
    const userSnapshot = await db.collection("users").where("email", "==", email).get();
    if (userSnapshot.empty) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    let user;
    userSnapshot.forEach((doc) => {
      user = { id: doc.id, ...doc.data() };
    });

   
    const tempCode = Math.floor(100000 + Math.random() * 900000).toString();
    const tempCodeData = {
      code: tempCode,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), 
      email,
      type: "mfa_qr_recovery",
    };

    await db.collection("mfa_codes").doc(email).set(tempCodeData);

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: "Código para Recuperar tu MFA",
      text: `Se ha solicitado un código QR para recuperar tu MFA. Usa este código temporal: ${tempCode}. Expira en 5 minutos. Si no solicitaste esto, por favor contacta al soporte.`,
    });

    res.status(200).json({
      message: "Código temporal enviado al correo",
      email,
    });
  } catch (error) {
    console.error("Error al solicitar código temporal para MFA QR:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor", message: error.message });
  }
};

const generateMFAQR = async (req, res) => {
  const { email, tempCode } = req.body;

  if (!email || !tempCode) {
    return res.status(400).json({ error: "Email y código temporal son requeridos" });
  }

  try {
    const tempCodeDoc = await db.collection("mfa_codes").doc(email).get();
    if (!tempCodeDoc.exists) {
      return res.status(400).json({ error: "Código temporal no encontrado" });
    }

    const tempCodeData = tempCodeDoc.data();
    if (tempCodeData.type !== "mfa_qr_recovery" || tempCodeData.code !== tempCode) {
      return res.status(400).json({ error: "Código temporal incorrecto" });
    }

    if (new Date() > new Date(tempCodeData.expiresAt)) {
      return res.status(400).json({ error: "Código temporal expirado" });
    }

    const userSnapshot = await db.collection("users").where("email", "==", email).get();
    if (userSnapshot.empty) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    let user;
    userSnapshot.forEach((doc) => {
      user = { id: doc.id, ...doc.data() };
    });

    let mfaSecret = user.mfaSecret;
    if (!mfaSecret || mfaSecret.trim() === "") {
      mfaSecret = speakeasy.generateSecret({ name: `EventApp (${email})` }).base32;
      await db.collection("users").doc(user.id).update({
        mfaSecret,
        updatedAt: new Date(),
      });
    }

    const otpauthUrl = speakeasy.otpauthURL({
      secret: mfaSecret,
      label: `EventApp (${email})`,
      issuer: "EventApp",
      encoding: "base32",
    });

    const qrDataURL = await qrcode.toDataURL(otpauthUrl);

    await db.collection("mfa_codes").doc(email).delete();

    res.status(200).json({
      message: "Código QR generado exitosamente",
      qr: qrDataURL,
      email,
    });
  } catch (error) {
    console.error("Error al generar código QR:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor", message: error.message });
  }
};

module.exports = { registerUser, loginUser, verifyRegisterMFA, verifyMFA, requestPasswordReset, resetPassword, requestMFAQRTempCode, generateMFAQR };
