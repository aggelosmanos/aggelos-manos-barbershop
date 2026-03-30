/**
 * Aggelos Manos Mens Salon — Booking Backend v2
 * Seat management · Race condition protection · Real-time polling
 *
 * npm install express stripe better-sqlite3 nodemailer dotenv cors
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

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
const CONFIG = {
  TOTAL_SEATS:     150,
  TIMEOUT_MINUTES: 10,
  FRONTEND_URL:    process.env.FRONTEND_URL,
};

const SEMINAR_PRICES = {
  'Look & Learn':                 { amount: 15000, label: 'Look & Learn' },
  'Workshop — Πρακτική Εξάσκηση': { amount: 20000, label: 'Workshop' },
  'Look & Learn & Workshop':      { amount: 30000, label: 'Look & Learn + Workshop' },
};

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id                TEXT    PRIMARY KEY,
    name              TEXT    NOT NULL,
    email             TEXT    NOT NULL,
    phone             TEXT    NOT NULL,
    seminar           TEXT    NOT NULL,
    message           TEXT,
    amount_cents      INTEGER NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'pending',
    stripe_session_id TEXT,
    created_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    confirmed_at      INTEGER,
    cancelled_at      INTEGER,
    cancel_reason     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_status  ON bookings(status);
  CREATE INDEX IF NOT EXISTS idx_bookings_email   ON bookings(email, seminar, status);
  CREATE INDEX IF NOT EXISTS idx_bookings_expires ON bookings(expires_at) WHERE status='pending';

  -- Ένα και μόνο row για το inventory — προστατεύεται από transactions
  CREATE TABLE IF NOT EXISTS seat_inventory (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    total_seats INTEGER NOT NULL DEFAULT 150,
    version     INTEGER NOT NULL DEFAULT 0
  );

  INSERT OR IGNORE INTO seat_inventory (id, total_seats, version) VALUES (1, 150, 0);
`);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function generateBookingId() {
  return 'AM-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function getAvailableSeats() {
  const inv = db.prepare('SELECT total_seats FROM seat_inventory WHERE id = 1').get();
  const now = Date.now();

  const pending = db.prepare(`
    SELECT COUNT(*) as cnt FROM bookings
    WHERE status = 'pending' AND expires_at > ?
  `).get(now).cnt;

  const confirmed = db.prepare(`
    SELECT COUNT(*) as cnt FROM bookings WHERE status = 'confirmed'
  `).get().cnt;

  return {
    total:     inv.total_seats,
    confirmed,
    pending,
    available: Math.max(0, inv.total_seats - confirmed - pending),
  };
}

/**
 * Atomic reservation με SQLite transaction.
 * Το transaction lock εγγυάται ότι 2 ταυτόχρονα requests
 * δεν μπορούν να πάρουν την ίδια θέση.
 */
const reserveSeat = db.transaction((bookingId, name, email, phone, seminar, message, amount, expiresAt) => {
  const now = Date.now();

  // Read-then-write ΜΕΣΑ στο transaction = atomic
  const seats = getAvailableSeats();
  if (seats.available <= 0) {
    return { ok: false, reason: 'no_seats' };
  }

  const existing = db.prepare(`
    SELECT id FROM bookings
    WHERE email = ? AND seminar = ? AND status IN ('pending','confirmed')
    AND created_at > ?
  `).get(email, seminar, now - 24 * 60 * 60 * 1000);

  if (existing) {
    return { ok: false, reason: 'duplicate', bookingId: existing.id };
  }

  db.prepare(`
    INSERT INTO bookings
      (id, name, email, phone, seminar, message, amount_cents, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(bookingId, name, email, phone, seminar, message || '', amount, now, expiresAt);

  return { ok: true };
});

async function sendConfirmationEmail(booking) {
  if (!process.env.EMAIL_USER) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
  await transporter.sendMail({
    from: `"Aggelos Manos Mens Salon" <${process.env.EMAIL_USER}>`,
    to: booking.email,
    subject: `✓ Επιβεβαίωση Κράτησης ${booking.id}`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a0a0a;color:#f0ebe0;border:1px solid #333">
        <h2 style="color:#fff">✓ Η κράτησή σας επιβεβαιώθηκε!</h2>
        <table style="width:100%;margin-top:20px">
          <tr><td style="color:#888;padding:6px 0">Κωδικός</td>   <td style="color:#fff;font-weight:bold">${booking.id}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Σεμινάριο</td> <td style="color:#fff">${booking.seminar}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Όνομα</td>     <td style="color:#fff">${booking.name}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Ποσό</td>      <td style="color:#fff">${(booking.amount_cents/100).toFixed(2)}€</td></tr>
        </table>
        <p style="margin-top:24px;color:#888;font-size:13px">Αθηνών 33, Αλμυρός · 6987 033949</p>
      </div>
    `,
  });
}

// ─── CLEANUP JOB ──────────────────────────────────────────────────────────────
function cleanupExpiredBookings() {
  const now    = Date.now();
  const result = db.prepare(`
    UPDATE bookings
    SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'timeout'
    WHERE status = 'pending' AND expires_at < ?
  `).run(now, now);

  if (result.changes > 0) {
    console.log(`[cleanup] ${result.changes} expired booking(s) → seats returned to pool`);
  }
}

setInterval(cleanupExpiredBookings, 60_000); // κάθε 1 λεπτό
cleanupExpiredBookings();                    // αμέσως στο boot

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' }));   // limit για safety
app.use(cors({ origin: CONFIG.FRONTEND_URL, methods: ['GET', 'POST'] }));

// Simple rate limiter (χωρίς εξωτερικό package)
const rateLimitMap = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const ip  = req.ip || req.connection.remoteAddress;
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const rec = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + windowMs; }
    rec.count++;
    rateLimitMap.set(key, rec);

    if (rec.count > max) {
      return res.status(429).json({ error: 'Πολλές αιτήσεις. Δοκιμάστε σε λίγο.' });
    }
    next();
  };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/**
 * GET /api/availability
 * Polling από frontend κάθε 15 δευτερόλεπτα
 * { total: 150, confirmed: 45, pending: 3, available: 102 }
 */
app.get('/api/availability', rateLimit(10_000, 10), (req, res) => {
  try {
    res.json(getAvailableSeats());
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/create-booking
 * Δημιουργεί pending κράτηση + Stripe Checkout Session
 */
app.post('/api/create-booking', rateLimit(60_000, 5), async (req, res) => {
  try {
    const { name, email, phone, seminar, message } = req.body;

    // Validation
    if (!name?.trim() || !email?.trim() || !phone?.trim() || !seminar) {
      return res.status(400).json({ error: 'Συμπληρώστε όλα τα υποχρεωτικά πεδία.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Μη έγκυρο email.' });
    }
    if (!/^[0-9\s\+\-\(\)]{7,15}$/.test(phone.trim())) {
      return res.status(400).json({ error: 'Μη έγκυρο τηλέφωνο.' });
    }

    const seminarData = SEMINAR_PRICES[seminar];
    if (!seminarData) {
      return res.status(400).json({ error: 'Άκυρο σεμινάριο.' });
    }

    const bookingId = generateBookingId();
    const expiresAt = Date.now() + CONFIG.TIMEOUT_MINUTES * 60_000;

    // Atomic seat reservation
    const result = reserveSeat(
      bookingId, name.trim(), email.trim(), phone.trim(),
      seminar, message?.trim(), seminarData.amount, expiresAt
    );

    if (!result.ok) {
      if (result.reason === 'no_seats') {
        return res.status(409).json({ error: 'Δεν υπάρχουν διαθέσιμες θέσεις.' });
      }
      if (result.reason === 'duplicate') {
        return res.status(409).json({
          error: `Υπάρχει ήδη κράτηση για αυτό το email (${result.bookingId}).`
        });
      }
    }

    // Stripe Checkout Session
    let session;
    try {
      session = await stripe.checkout.sessions.create({
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
        success_url: `${CONFIG.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&booking_id=${bookingId}`,
        cancel_url:  `${CONFIG.FRONTEND_URL}/?cancelled=1#booking-seminar`,
        expires_at:  Math.floor(expiresAt / 1000),
        payment_intent_data: {
          description: `Κράτηση #${bookingId}`,
          metadata: { bookingId },
        },
      });
    } catch (stripeErr) {
      // Stripe απέτυχε — ελευθέρωσε αμέσως τη θέση
      db.prepare(`
        UPDATE bookings SET status='cancelled', cancelled_at=?, cancel_reason='stripe_error'
        WHERE id=?
      `).run(Date.now(), bookingId);
      console.error('[create-booking] Stripe error:', stripeErr.message);
      return res.status(502).json({ error: 'Σφάλμα Stripe. Δοκιμάστε ξανά.' });
    }

    db.prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?')
      .run(session.id, bookingId);

    console.log(`[create-booking] ${bookingId} | ${seminar} | ${email}`);
    res.json({ sessionUrl: session.url, bookingId });

  } catch (err) {
    console.error('[create-booking]', err);
    res.status(500).json({ error: 'Σφάλμα διακομιστή.' });
  }
});

/**
 * POST /api/webhook
 * Stripe webhook — η μόνη αξιόπιστη επιβεβαίωση πληρωμής
 */
app.post('/api/webhook', async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] Signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session   = event.data.object;
    const bookingId = session.metadata?.bookingId;
    if (!bookingId) return res.json({ received: true });

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!booking) {
      console.error(`[webhook] Booking not found: ${bookingId}`);
      return res.json({ received: true });
    }

    if (booking.status === 'confirmed') {
      return res.json({ received: true }); // idempotent
    }

    if (booking.status === 'cancelled') {
      // Πληρώθηκε αλλά η κράτηση είχε ήδη ακυρωθεί — χρειάζεται refund
      console.warn(`[webhook] ALERT: Payment for cancelled booking ${bookingId} — issue refund manually`);
      // Uncomment για αυτόματο refund:
      // await stripe.refunds.create({ payment_intent: session.payment_intent });
      return res.json({ received: true });
    }

    // Confirm — χρησιμοποιούμε AND status='pending' για extra safety
    const updated = db.prepare(`
      UPDATE bookings SET status='confirmed', confirmed_at=?
      WHERE id=? AND status='pending'
    `).run(Date.now(), bookingId);

    if (updated.changes > 0) {
      console.log(`[webhook] Confirmed: ${bookingId} — 1 seat locked permanently`);
      try { await sendConfirmationEmail(booking); } catch (e) { console.error('[webhook] Email error:', e.message); }
    }
  }

  if (event.type === 'checkout.session.expired') {
    const bookingId = event.data.object.metadata?.bookingId;
    if (bookingId) {
      db.prepare(`
        UPDATE bookings SET status='cancelled', cancelled_at=?, cancel_reason='stripe_expired'
        WHERE id=? AND status='pending'
      `).run(Date.now(), bookingId);
      console.log(`[webhook] Stripe session expired → ${bookingId} cancelled`);
    }
  }

  res.json({ received: true });
});

/**
 * GET /api/booking-status/:id
 * Polling από success.html
 */
app.get('/api/booking-status/:id', rateLimit(10_000, 20), (req, res) => {
  const id      = req.params.id.replace(/[^A-Z0-9\-]/g, '').slice(0, 20);
  const booking = db.prepare(`
    SELECT id, name, seminar, status, confirmed_at, amount_cents FROM bookings WHERE id = ?
  `).get(id);

  if (!booking) return res.status(404).json({ error: 'Not found' });
  res.json(booking);
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Server on port ${PORT}`);
  const seats = getAvailableSeats();
  console.log(`✓ Available seats: ${seats.available}/${seats.total}`);
});
