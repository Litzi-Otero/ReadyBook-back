// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { registerUser, loginUser, verifyMFA, verifyRegisterMFA, requestPasswordReset, resetPassword, generateMFAQR, requestMFAQRTempCode } = require("./controllers/authController");
const { createUser, getUsers, updateUser, deleteUser, updateProfile, verifyProfileMFA } = require("./controllers/UserController");
const { getReservedBooks, reserveBook, getReservedUserBooks, addToWaitingList, getWaitingListBooks, cancelReservation, cancelWaitingList } = require("./controllers/booksController");

const app = express();
const port = process.env.PORT || 3000;

const clients = new Map();

const corsOptions = {
  origin: process.env.CLIENT_URL || "*",
  methods: "GET,POST,PUT,DELETE",
  allowedHeaders: "Content-Type,Authorization",
};

app.use(cors(corsOptions));
app.use(express.json());

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const clientId = Date.now();
  clients.set(clientId, res);

  req.on("close", () => {
    clients.delete(clientId);
    res.end();
  });
});

const notifyClients = (eventData) => {
  clients.forEach((client) => {
    client.write(`data: ${JSON.stringify(eventData)}\n\n`);
  });
};

app.post("/auth/register", registerUser);
app.post("/auth/login", loginUser);
app.post("/auth/verify-mfa", verifyMFA);
app.post("/auth/password-reset-request", requestPasswordReset);
app.post("/auth/password-reset", resetPassword);
app.post("/auth/generate-mfa-qr", generateMFAQR);
app.post("/auth/request-mfa-qr-code", requestMFAQRTempCode);

app.get("/reserved-books", getReservedBooks);
app.post("/books/reserve", (req, res) => reserveBook(req, res, notifyClients));
app.get("/books/reserved-user", getReservedUserBooks);
app.post("/books/waiting-list", addToWaitingList);
app.get("/books/waiting-list", getWaitingListBooks);
app.post("/books/cancel-reservation", (req, res) => cancelReservation(req, res, notifyClients)); // Nueva ruta
app.post("/books/cancel-waiting-list", cancelWaitingList);

app.post("/users", createUser);
app.get("/users", getUsers);
app.put("/users/:id", updateUser);
app.delete("/users/:id", deleteUser);
app.post("/users/update-profile", updateProfile);
app.post("/users/verify-profile-mfa", verifyProfileMFA);
app.post("/users/verify-register-mfa", verifyRegisterMFA);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Error interno del servidor" });
});

app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});
