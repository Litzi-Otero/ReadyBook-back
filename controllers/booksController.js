// controllers/booksController.js
require("dotenv").config();
const db = require("../firebase");
const nodemailer = require("nodemailer");

const getReservedBooks = async (req, res) => {
  const { title } = req.query;

  try {
    if (!title) {
      return res.status(400).json({ error: "title es requerido" });
    }

    const snapshot = await db
      .collection("reserved_books")
      .where("title", "==", title)
      .get();

    const reservedBooks = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      reservedAt: doc.data().reservedAt.toDate().toISOString(),
      reservedUntil: doc.data().reservedUntil.toDate().toISOString(),
    }));

    res.json(reservedBooks);
  } catch (error) {
    console.error("Error fetching reserved books:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor" });
  }
};

const getReservedUserBooks = async (req, res) => {
  const { reservedBy, title } = req.query;

  try {
    if (!reservedBy) {
      return res.status(400).json({ error: "reservedBy es requerido" });
    }

    let query = db.collection("reserved_books").where("reservedBy", "==", reservedBy);

    if (title) {
      query = query.where("title", "==", title);
    }

    const snapshot = await query.get();

    const reservedBooks = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      reservedAt: doc.data().reservedAt.toDate().toISOString(),
      reservedUntil: doc.data().reservedUntil.toDate().toISOString(),
    }));

    res.json(reservedBooks);
  } catch (error) {
    console.error("Error fetching reserved books:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor" });
  }
};

const getWaitingListBooks = async (req, res) => {
  const { userId } = req.query;

  try {
    if (!userId) {
      return res.status(400).json({ error: "userId es requerido" });
    }

    const reservationsSnapshot = await db.collection("reserved_books").get();
    const waitingListBooks = [];

    for (const reservationDoc of reservationsSnapshot.docs) {
      const waitingListSnapshot = await reservationDoc.ref
        .collection("waiting_list")
        .where("userId", "==", userId)
        .get();

      if (!waitingListSnapshot.empty) {
        const reservationData = reservationDoc.data();
        waitingListBooks.push({
          id: reservationDoc.id,
          ...reservationData,
          reservedAt: reservationData.reservedAt.toDate().toISOString(),
          reservedUntil: reservationData.reservedUntil.toDate().toISOString(),
          waitingSince: waitingListSnapshot.docs[0].data().addedAt.toDate().toISOString(),
        });
      }
    }

    res.json(waitingListBooks);
  } catch (error) {
    console.error("Error fetching waiting list books:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor" });
  }
};

const reserveBook = async (req, res, notifyClients) => {
  const { bookId, title, authors, thumbnail, description, reservedBy, reservedAt, reservedUntil, email } = req.body;

  try {
    const existingReservation = await db
      .collection("reserved_books")
      .where("title", "==", title)
      .get();

    if (!existingReservation.empty) {
      const reservation = existingReservation.docs[0].data();
      if (reservation.reservedBy === reservedBy) {
        return res.status(400).json({ error: "Ya has apartado este libro" });
      }
      return res.status(400).json({
        error: "El libro ya está reservado por otro usuario",
        reservedUntil: reservation.reservedUntil.toDate().toISOString(),
      });
    }

    const reservationData = {
      bookId,
      title,
      authors,
      thumbnail,
      description,
      reservedBy,
      reservedAt: new Date(reservedAt),
      reservedUntil: new Date(reservedUntil),
    };

    const docRef = await db.collection("reserved_books").add(reservationData);

    const eventData = {
      event: "newBookReservation",
      data: {
        title,
        reservedAt: reservationData.reservedAt.toISOString(), // Ya es Date, no necesita toDate()
        reservedUntil: reservationData.reservedUntil.toISOString(), // Ya es Date, no necesita toDate()
      },
    };
    notifyClients(eventData);

    // Intentar enviar el correo, pero no fallar si falla
    if (email) {
      try {
        await sendReservationEmail(email, reservationData);
      } catch (emailError) {
        console.error("Error enviando correo:", emailError.message, emailError.stack);
      }
    } else {
      console.warn("No se proporcionó un email para la notificación");
    }

    res.json({ message: "Libro apartado exitosamente" });
  } catch (error) {
    console.error("Error al apartar libro:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor", details: error.message });
  }
};

const addToWaitingList = async (req, res) => {
  const { title, userId } = req.body;

  try {
    const reservationSnapshot = await db
      .collection("reserved_books")
      .where("title", "==", title)
      .get();

    if (reservationSnapshot.empty) {
      return res.status(404).json({ error: "El libro no está reservado actualmente" });
    }

    const reservationDoc = reservationSnapshot.docs[0];
    const reservationRef = reservationDoc.ref;
    const reservationData = reservationDoc.data();

    if (reservationData.reservedBy === userId) {
      return res.status(400).json({ error: "Ya tienes este libro reservado" });
    }

    const waitingListSnapshot = await reservationRef
      .collection("waiting_list")
      .where("userId", "==", userId)
      .get();

    if (!waitingListSnapshot.empty) {
      return res.status(400).json({ error: "Ya estás en la lista de espera para este libro" });
    }

    await reservationRef.collection("waiting_list").add({
      userId,
      addedAt: new Date(),
    });

    res.json({ message: "Te has añadido a la lista de espera exitosamente" });
  } catch (error) {
    console.error("Error al añadir a la lista de espera:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor" });
  }
};

const cancelReservation = async (req, res, notifyClients) => {
  const { reservationId, userId } = req.body;

  try {
    if (!reservationId || !userId) {
      return res.status(400).json({ error: "reservationId y userId son requeridos" });
    }

    const reservationRef = db.collection("reserved_books").doc(reservationId);
    const reservationDoc = await reservationRef.get();

    if (!reservationDoc.exists) {
      return res.status(404).json({ error: "Reserva no encontrada" });
    }

    const reservationData = reservationDoc.data();

    if (reservationData.reservedBy !== userId) {
      return res.status(403).json({ error: "No tienes permiso para cancelar esta reserva" });
    }

    const reservedUntil = new Date(reservationData.reservedUntil);
    const now = new Date();
    if (now > reservedUntil) {
      return res.status(400).json({ error: "No se puede cancelar una reserva ya vencida" });
    }

    await reservationRef.delete();

    const eventData = {
      event: "reservationCancelled",
      data: {
        title: reservationData.title,
      },
    };
    notifyClients(eventData);

    res.json({ message: "Reserva cancelada exitosamente" });
  } catch (error) {
    console.error("Error al cancelar reserva:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor" });
  }
};

// Configuración de Nodemailer
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const sendReservationEmail = async (email, reservationData) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: "Confirmación de Reserva de Libro",
    html: `
      <h2>¡Reserva Confirmada!</h2>
      <p>Hola,</p>
      <p>Has reservado el siguiente libro:</p>
      <ul>
        <li><strong>Título:</strong> ${reservationData.title}</li>
        <li><strong>Fecha de Retiro:</strong> ${new Date(reservationData.reservedAt).toLocaleDateString()}</li>
        <li><strong>Fecha de Entrega:</strong> ${new Date(reservationData.reservedUntil).toLocaleDateString()}</li>
      </ul>
      <p>Por favor, recoge tu libro antes de la fecha de entrega.</p>
      <p>Gracias,<br>Equipo de la Biblioteca ReadyBook</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Correo enviado a ${email}`);
  } catch (error) {
    console.error("Error enviando correo:", error.message, error.stack);
    throw new Error("No se pudo enviar el correo de confirmación");
  }
};

const cancelWaitingList = async (req, res) => {
  const { reservationId, userId } = req.body;

  try {
    if (!reservationId || !userId) {
      return res.status(400).json({ error: "reservationId y userId son requeridos" });
    }

    const reservationRef = db.collection("reserved_books").doc(reservationId);
    const reservationDoc = await reservationRef.get();

    if (!reservationDoc.exists) {
      return res.status(404).json({ error: "Reserva no encontrada" });
    }

    const waitingListRef = reservationRef.collection("waiting_list");
    const waitingListQuery = await waitingListRef.where("userId", "==", userId).get();

    if (waitingListQuery.empty) {
      return res.status(404).json({ error: "No estás en la lista de espera para este libro" });
    }

    // Eliminar el documento del usuario en la lista de espera
    const waitingListDoc = waitingListQuery.docs[0];
    await waitingListDoc.ref.delete();

    res.json({ message: "Cancelado de la lista de espera exitosamente" });
  } catch (error) {
    console.error("Error al cancelar de la lista de espera:", error.message, error.stack);
    res.status(500).json({ error: "Error interno en el servidor" });
  }
};

module.exports = {
  getReservedBooks,
  reserveBook,
  getReservedUserBooks,
  addToWaitingList,
  getWaitingListBooks,
  cancelReservation,
  cancelWaitingList,
};