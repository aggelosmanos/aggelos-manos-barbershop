/**
 * Aggelos Manos Mens Salon — Booking Backend
 * Stack: Node.js + Express + Stripe + SQLite (ή αλλάξτε σε PostgreSQL)
 *
 * Εγκατάσταση:
 *   npm install express stripe better-sqlite3 nodemailer dotenv cors
 *
 * .env αρχείο (ΠΟΤΕ μην το κάνετε commit):
 *   STRIPE_SECRET_KEY=sk_live_...
 *   STRIPE_WEBHOOK_SECRET=whsec_...
 *   STRIPE_PUBLISHABLE_KEY=pk_live_...
 *   FRONTEND_URL=https://aggelosmanosmenssalon.gr
 *   EMAIL_USER=your@email.com
 *   EMAIL_PASS=yourpassword
 *   PORT=3000
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const Stripe     = require('stripe');
const Database   = require('better-sqlite3');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const db     = new Database('bookings.db');

// ─── DATABASE SETUP ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    email        TEXT NOT NULL,
    phone        TEXT NOT NULL,
    seminar      TEXT NOT NULL,
    message      TEXT,
    amount_cents INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    stripe_session_id TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    confirmed_at INTEGER
  )
`);

// ─── SEMINAR PRICES ──────────────────────────────────────────────────────────
// Οι τιμές ορίζονται ΜΟΝΟ στον server — ποτέ δεν εμπιστευόμαστε τιμές από frontend
const SEMINAR_PRICES = {
  'Look & Learn':                    { amount: 15000, label: 'Look & Learn' },       // 150.00€
  'Workshop — Πρακτική Εξάσκηση':    { amount: 20000, label: 'Workshop' },           // 200.00€
  'Look & Learn & Workshop':         { amount: 30000, label: 'Look & Learn + Workshop' }, // 300.00€
};
// ↑ Αλλάξτε τις τιμές εδώ (σε cents)

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

// Το Stripe webhook χρειάζεται raw body — πρέπει να μπει ΠΡΙΝ το express.json()
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST'],
}));

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function generateBookingId() {
  return 'AM-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

async function sendConfirmationEmail(booking) {
  const transporter = nodemailer.createTransport({
    service: 'gmail', // ή χρησιμοποιήστε SMTP provider
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });

  await transporter.sendMail({
    from: `"Aggelos Manos Mens Salon" <${process.env.EMAIL_USER}>`,
    to: booking.email,
    subject: `✓ Επιβεβαίωση Κράτησης ${booking.id}`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a0a0a;color:#f0ebe0;border:1px solid #333">
        <h2 style="color:#fff;margin-bottom:8px">Η κράτησή σας επιβεβαιώθηκε!</h2>
        <p style="color:#aaa;margin-bottom:24px">Σας ευχαριστούμε για την εγγραφή σας.</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#888;font-size:13px">ΚΩΔΙΚΟΣ</td><td style="color:#fff;font-weight:bold">${booking.id}</td></tr>
          <tr><td style="padding:8px 0;color:#888;font-size:13px">ΣΕΜΙΝΑΡΙΟ</td><td style="color:#fff">${booking.seminar}</td></tr>
          <tr><td style="padding:8px 0;color:#888;font-size:13px">ΟΝΟΜΑ</td><td style="color:#fff">${booking.name}</td></tr>
          <tr><td style="padding:8px 0;color:#888;font-size:13px">ΠΟΣΟ</td><td style="color:#fff">${(booking.amount_cents/100).toFixed(2)}€</td></tr>
        </table>
        <p style="margin-top:24px;color:#888;font-size:13px">Θα επικοινωνήσουμε μαζί σας για τις λεπτομέρειες.<br>Αθηνών 33, Αλμυρός · 6987 033949</p>
      </div>
    `,
  });
}

// ─── CLEANUP JOB — ακυρώνει expired pending κρατήσεις ────────────────────────
function cleanupExpiredBookings() {
  const now = Date.now();
  const result = db.prepare(`
    UPDATE bookings SET status = 'cancelled'
    WHERE status = 'pending' AND expires_at < ?
  `).run(now);
  if (result.changes > 0) {
    console.log(`[cleanup] Cancelled ${result.changes} expired booking(s)`);
  }
}
setInterval(cleanupExpiredBookings, 60 * 1000); // κάθε 1 λεπτό
cleanupExpiredBookings(); // και αμέσως στην εκκίνηση

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/**
 * POST /api/create-booking
 * Δημιουργεί pending κράτηση + Stripe Checkout Session
 */
app.post('/api/create-booking', async (req, res) => {
  try {
    const { name, email, phone, seminar, message } = req.body;

    // 1. Validation
    if (!name || !email || !phone || !seminar) {
      return res.status(400).json({ error: 'Συμπληρώστε όλα τα υποχρεωτικά πεδία.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Μη έγκυρο email.' });
    }

    // 2. Έλεγχος αν υπάρχει ήδη active κράτηση για αυτό το email (anti-double-booking)
    const existing = db.prepare(`
      SELECT id FROM bookings
      WHERE email = ? AND seminar = ? AND status IN ('pending','confirmed')
      AND created_at > ?
    `).get(email, seminar, Date.now() - 24 * 60 * 60 * 1000); // εντός 24 ωρών

    if (existing) {
      return res.status(409).json({
        error: `Υπάρχει ήδη κράτηση για αυτό το email (${existing.id}). Επικοινωνήστε μαζί μας αν χρειάζεστε βοήθεια.`
      });
    }

    // 3. Εξαγωγή τιμής από server (ΟΧΙ από frontend)
    const seminarData = SEMINAR_PRICES[seminar];
    if (!seminarData) {
      return res.status(400).json({ error: 'Άκυρο σεμινάριο.' });
    }

    // 4. Δημιουργία booking record
    const bookingId = generateBookingId();
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000; // 10 λεπτά

    db.prepare(`
      INSERT INTO bookings (id, name, email, phone, seminar, message, amount_cents, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(bookingId, name, email, phone, seminar, message || '', seminarData.amount, now, expiresAt);

    // 5. Δημιουργία Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Σεμινάριο: ${seminarData.label}`,
            description: `Κράτηση #${bookingId} — Aggelos Manos Mens Salon`,
          },
          unit_amount: seminarData.amount,
        },
        quantity: 1,
      }],
      customer_email: email,
      metadata: { bookingId, name, phone, seminar },
      success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&booking_id=${bookingId}`,
      cancel_url:  `${process.env.FRONTEND_URL}/?cancelled=1#booking-seminar`,
      expires_at: Math.floor(expiresAt / 1000), // Stripe timeout = ίδιο με το δικό μας
      payment_intent_data: {
        description: `Κράτηση #${bookingId}`,
        metadata: { bookingId },
      },
    });

    // 6. Αποθήκευση session id
    db.prepare(`UPDATE bookings SET stripe_session_id = ? WHERE id = ?`)
      .run(session.id, bookingId);

    res.json({ sessionUrl: session.url, bookingId });

  } catch (err) {
    console.error('[create-booking]', err);
    res.status(500).json({ error: 'Σφάλμα διακομιστή. Δοκιμάστε ξανά.' });
  }
});

/**
 * POST /api/webhook
 * Stripe webhook — επιβεβαίωση πληρωμής
 * Στο Stripe Dashboard: Webhooks → Add endpoint → /api/webhook → event: checkout.session.completed
 */
app.post('/api/webhook', async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session   = event.data.object;
    const bookingId = session.metadata?.bookingId;

    if (!bookingId) {
      return res.status(400).json({ error: 'No bookingId in metadata' });
    }

    const booking = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(bookingId);

    if (!booking) {
      console.error(`[webhook] Booking not found: ${bookingId}`);
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Idempotency: αν ήδη confirmed, μην ξανακάνεις τίποτα
    if (booking.status === 'confirmed') {
      return res.json({ received: true });
    }

    // Επιβεβαίωση κράτησης
    db.prepare(`
      UPDATE bookings SET status = 'confirmed', confirmed_at = ? WHERE id = ?
    `).run(Date.now(), bookingId);

    console.log(`[webhook] Booking confirmed: ${bookingId}`);

    // Αποστολή email επιβεβαίωσης
    try {
      await sendConfirmationEmail(booking);
      console.log(`[webhook] Confirmation email sent to ${booking.email}`);
    } catch (emailErr) {
      console.error('[webhook] Email failed:', emailErr.message);
      // Δεν επιστρέφουμε error — η πληρωμή έγινε, το email είναι secondary
    }
  }

  res.json({ received: true });
});

/**
 * GET /api/booking-status/:id
 * Ο frontend ελέγχει αν η κράτηση επιβεβαιώθηκε (polling από success page)
 */
app.get('/api/booking-status/:id', (req, res) => {
  const booking = db.prepare(`
    SELECT id, name, seminar, status, confirmed_at FROM bookings WHERE id = ?
  `).get(req.params.id);

  if (!booking) return res.status(404).json({ error: 'Not found' });
  res.json(booking);
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
