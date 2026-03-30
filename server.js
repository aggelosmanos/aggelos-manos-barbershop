/**
 * Aggelos Manos Mens Salon — Booking Backend v3
 * Δύο σεμινάρια με cross-decrement λογική:
 *   - Look & Learn:          150 θέσεις
 *   - Look & Learn Workshop:   6 θέσεις (κάθε κράτηση -1 και από τα 150)
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
  TIMEOUT_MINUTES: 30,
  FRONTEND_URL: process.env.FRONTEND_URL,
};

/**
 * SEMINAR DEFINITIONS
 *
 * seats_key:        το inventory row που αφαιρείται όταν κάποιος κλείσει αυτό το σεμινάριο
 * also_decrements:  επιπλέον inventory rows που αφαιρούνται ταυτόχρονα (cross-decrement)
 *
 * Look & Learn Workshop κρατάει 1 από τις 6 workshop θέσεις
 * ΚΑΙ 1 από τις 150 look-and-learn θέσεις.
 */
const SEMINARS = {
  'Look & Learn': {
    label:           'Look & Learn',
    amount:          10000,          // 150.00€ — αλλάξτε εδώ
    seats_key:       'look_and_learn',
    also_decrements: [],             // μόνο το δικό του pool
  },
  'Look & Learn Workshop': {
    label:           'Look & Learn Workshop',
    amount:          17000,          // 300.00€ — αλλάξτε εδώ
    seats_key:       'workshop',
    also_decrements: ['look_and_learn'], // αφαιρεί και από τα 150
  },
};

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
db.exec(`
  -- Inventory: ένα row ανά pool θέσεων
  -- id = 'look_and_learn' | 'workshop'
  CREATE TABLE IF NOT EXISTS seat_pools (
    id          TEXT    PRIMARY KEY,
    label       TEXT    NOT NULL,
    total_seats INTEGER NOT NULL,
    version     INTEGER NOT NULL DEFAULT 0
  );

  -- Seed αρχικά pools
  INSERT OR IGNORE INTO seat_pools (id, label, total_seats) VALUES
    ('look_and_learn', 'Look & Learn',          150),
    ('workshop',       'Look & Learn Workshop',   6);

  -- Κρατήσεις
  CREATE TABLE IF NOT EXISTS bookings (
    id                TEXT    PRIMARY KEY,
    name              TEXT    NOT NULL,
    email             TEXT    NOT NULL,
    phone             TEXT    NOT NULL,
    seminar           TEXT    NOT NULL,
    message           TEXT,
    amount_cents      INTEGER NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'pending',
    -- status: pending | confirmed | cancelled
    stripe_session_id TEXT,
    created_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    confirmed_at      INTEGER,
    cancelled_at      INTEGER,
    cancel_reason     TEXT
    -- cancel_reason: timeout | stripe_error | stripe_expired
  );

  -- Καταγραφή ποια pools αφαιρέθηκαν για κάθε κράτηση
  -- (χρειάζεται για σωστό rollback σε ακύρωση)
  CREATE TABLE IF NOT EXISTS booking_seat_locks (
    booking_id TEXT NOT NULL,
    pool_id    TEXT NOT NULL,
    PRIMARY KEY (booking_id, pool_id),
    FOREIGN KEY (booking_id) REFERENCES bookings(id),
    FOREIGN KEY (pool_id)    REFERENCES seat_pools(id)
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_status  ON bookings(status);
  CREATE INDEX IF NOT EXISTS idx_bookings_email   ON bookings(email, seminar, status);
  CREATE INDEX IF NOT EXISTS idx_bookings_expires ON bookings(expires_at) WHERE status='pending';
`);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function generateBookingId() {
  return 'AM-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

/**
 * Υπολογισμός διαθέσιμων θέσεων για ένα pool.
 * available = total - confirmed - active_pending
 * Τρέχει ΜΕΣΑ σε transaction για consistency.
 */
function getPoolAvailability(poolId) {
  const pool = db.prepare('SELECT * FROM seat_pools WHERE id = ?').get(poolId);
  const now  = Date.now();

  // Πόσες pending κρατήσεις κρατούν θέση σε αυτό το pool (μέσω booking_seat_locks)
  const pending = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM bookings b
    JOIN booking_seat_locks l ON l.booking_id = b.id
    WHERE l.pool_id = ? AND b.status = 'pending' AND b.expires_at > ?
  `).get(poolId, now).cnt;

  // Πόσες confirmed κρατήσεις κρατούν θέση σε αυτό το pool
  const confirmed = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM bookings b
    JOIN booking_seat_locks l ON l.booking_id = b.id
    WHERE l.pool_id = ? AND b.status = 'confirmed'
  `).get(poolId).cnt;

  return {
    id:        poolId,
    label:     pool.label,
    total:     pool.total_seats,
    confirmed,
    pending,
    available: Math.max(0, pool.total_seats - confirmed - pending),
  };
}

/**
 * Atomic reservation με SQLite transaction.
 *
 * Για "Look & Learn Workshop":
 *   - Ελέγχει ότι υπάρχει θέση στο 'workshop' pool (6)
 *   - Ελέγχει ότι υπάρχει θέση στο 'look_and_learn' pool (150)
 *   - Αφαιρεί και από τα δύο atomically
 *
 * Για "Look & Learn":
 *   - Ελέγχει και αφαιρεί μόνο από το 'look_and_learn' pool
 */
const reserveSeats = db.transaction((bookingId, name, email, phone, seminar, message, amount, expiresAt) => {
  const now        = Date.now();
  const seminarDef = SEMINARS[seminar];

  // Όλα τα pools που πρέπει να ελεγχθούν και αφαιρεθούν
  const poolsToLock = [seminarDef.seats_key, ...seminarDef.also_decrements];

  // 1. Ελέγχουμε διαθεσιμότητα ΣΕ ΟΛΑ τα pools atomically
  for (const poolId of poolsToLock) {
    const avail = getPoolAvailability(poolId);
    if (avail.available <= 0) {
      return {
        ok:     false,
        reason: 'no_seats',
        pool:   poolId,
        label:  avail.label,
      };
    }
  }

  // 2. Anti-double-booking check
  const existing = db.prepare(`
    SELECT id FROM bookings
    WHERE email = ? AND seminar = ? AND status IN ('pending','confirmed')
    AND created_at > ?
  `).get(email, seminar, now - 24 * 60 * 60 * 1000);

  if (existing) {
    return { ok: false, reason: 'duplicate', bookingId: existing.id };
  }

  // 3. Insert κράτηση
  db.prepare(`
    INSERT INTO bookings
      (id, name, email, phone, seminar, message, amount_cents, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(bookingId, name, email, phone, seminar, message || '', amount, now, expiresAt);

  // 4. Καταγράφουμε ποια pools κλειδώθηκαν (για rollback)
  for (const poolId of poolsToLock) {
    db.prepare(`
      INSERT INTO booking_seat_locks (booking_id, pool_id) VALUES (?, ?)
    `).run(bookingId, poolId);
  }

  return { ok: true, lockedPools: poolsToLock };
});

async function sendConfirmationEmail(booking) {
  if (!process.env.EMAIL_USER) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });

  // Email στον πελάτη
  await transporter.sendMail({
    from: `"Aggelos Manos Mens Salon" <${process.env.EMAIL_USER}>`,
    to:   booking.email,
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

  // Email στον ιδιοκτήτη
  const ownerEmail = process.env.OWNER_EMAIL || process.env.EMAIL_USER;
  await transporter.sendMail({
    from: `"Aggelos Manos Mens Salon" <${process.env.EMAIL_USER}>`,
    to:   ownerEmail,
    subject: `🆕 Νέα Κράτηση ${booking.id} — ${booking.seminar}`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a0a0a;color:#f0ebe0;border:1px solid #333">
        <h2 style="color:#fff">🆕 Νέα Κράτηση!</h2>
        <table style="width:100%;margin-top:20px">
          <tr><td style="color:#888;padding:6px 0">Κωδικός</td>    <td style="color:#fff;font-weight:bold">${booking.id}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Σεμινάριο</td>  <td style="color:#fff">${booking.seminar}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Όνομα</td>      <td style="color:#fff">${booking.name}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Email</td>       <td style="color:#fff">${booking.email}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Τηλέφωνο</td>   <td style="color:#fff">${booking.phone}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Ποσό</td>        <td style="color:#fff">${(booking.amount_cents/100).toFixed(2)}€</td></tr>
        </table>
      </div>
    `,
  });
}

// ─── CLEANUP JOB ──────────────────────────────────────────────────────────────
// Κάθε λεπτό: ακυρώνει expired pending → θέσεις επιστρέφουν αυτόματα
// (δεν χρειάζεται manual rollback γιατί η getPoolAvailability
//  υπολογίζει live: total - confirmed - active_pending)
function cleanupExpiredBookings() {
  const now    = Date.now();
  const result = db.prepare(`
    UPDATE bookings
    SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'timeout'
    WHERE status = 'pending' AND expires_at < ?
  `).run(now, now);

  if (result.changes > 0) {
    console.log(`[cleanup] ${result.changes} expired booking(s) → seats returned to all pools`);
  }
}

setInterval(cleanupExpiredBookings, 60_000);
cleanupExpiredBookings();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' }));
const ALLOWED_ORIGINS = ['https://aggelosmanosmenssalon.gr','https://www.aggelosmanosmenssalon.gr','https://aggelosmanos.github.io',CONFIG.FRONTEND_URL].filter(Boolean);
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST']
}));

// Simple rate limiter
const _rl = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const rec = _rl.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + windowMs; }
    rec.count++;
    _rl.set(key, rec);
    if (rec.count > max) return res.status(429).json({ error: 'Πολλές αιτήσεις. Δοκιμάστε σε λίγο.' });
    next();
  };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/**
 * GET /api/availability
 * Επιστρέφει διαθεσιμότητα και για τα δύο pools.
 *
 * Response:
 * {
 *   look_and_learn: { total: 150, confirmed: 10, pending: 2, available: 138 },
 *   workshop:       { total: 6,   confirmed: 1,  pending: 1, available: 4  }
 * }
 */
app.get('/api/availability', rateLimit(10_000, 20), (req, res) => {
  try {
    res.json({
      look_and_learn: getPoolAvailability('look_and_learn'),
      workshop:       getPoolAvailability('workshop'),
    });
  } catch (err) {
    console.error('[availability]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/create-booking
 * Atomic κράτηση + Stripe Checkout Session
 *
 * Body: { name, email, phone, seminar, message }
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

    const seminarDef = SEMINARS[seminar];
    if (!seminarDef) {
      return res.status(400).json({ error: 'Άκυρο σεμινάριο.' });
    }

    const bookingId = generateBookingId();
    const expiresAt = Date.now() + CONFIG.TIMEOUT_MINUTES * 60_000;

    // Atomic reservation (transaction)
    const result = reserveSeats(
      bookingId, name.trim(), email.trim(), phone.trim(),
      seminar, message?.trim(), seminarDef.amount, expiresAt
    );

    if (!result.ok) {
      if (result.reason === 'no_seats') {
        const msg = result.pool === 'workshop'
          ? 'Δεν υπάρχουν διαθέσιμες θέσεις για το Workshop.'
          : 'Δεν υπάρχουν διαθέσιμες θέσεις για το Look & Learn.';
        return res.status(409).json({ error: msg });
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
              name: `Σεμινάριο: ${seminarDef.label}`,
              description: `Κράτηση #${bookingId} — Aggelos Manos Mens Salon`,
            },
            unit_amount: seminarDef.amount,
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
      // Stripe απέτυχε → ακύρωσε αμέσως (θέσεις ελευθερώνονται αυτόματα)
      db.prepare(`
        UPDATE bookings SET status='cancelled', cancelled_at=?, cancel_reason='stripe_error'
        WHERE id=?
      `).run(Date.now(), bookingId);
      console.error('[create-booking] Stripe error:', stripeErr.message);
      return res.status(502).json({ error: 'Σφάλμα Stripe. Δοκιμάστε ξανά.' });
    }

    db.prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?')
      .run(session.id, bookingId);

    console.log(`[create-booking] ${bookingId} | ${seminar} | pools: ${result.lockedPools.join(', ')}`);
    res.json({ sessionUrl: session.url, bookingId });

  } catch (err) {
    console.error('[create-booking]', err);
    res.status(500).json({ error: 'Σφάλμα διακομιστή.' });
  }
});

/**
 * POST /api/webhook
 * Stripe webhook — μοναδικό σημείο επιβεβαίωσης πληρωμής
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
    const bookingId = event.data.object.metadata?.bookingId;
    if (!bookingId) return res.json({ received: true });

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!booking) return res.json({ received: true });
    if (booking.status === 'confirmed') return res.json({ received: true }); // idempotent

    if (booking.status === 'cancelled') {
      // Πληρώθηκε αλλά είχε λήξει — χρειάζεται manual refund
      console.warn(`[webhook] ALERT: Payment for cancelled booking ${bookingId}`);
      // await stripe.refunds.create({ payment_intent: event.data.object.payment_intent });
      return res.json({ received: true });
    }

    db.prepare(`
      UPDATE bookings SET status='confirmed', confirmed_at=? WHERE id=? AND status='pending'
    `).run(Date.now(), bookingId);

    console.log(`[webhook] Confirmed: ${bookingId} | seminar: ${booking.seminar}`);
    try { await sendConfirmationEmail(booking); } catch (e) { console.error('[webhook] Email error:', e.message); }
  }

  if (event.type === 'checkout.session.expired') {
    const bookingId = event.data.object.metadata?.bookingId;
    if (bookingId) {
      db.prepare(`
        UPDATE bookings SET status='cancelled', cancelled_at=?, cancel_reason='stripe_expired'
        WHERE id=? AND status='pending'
      `).run(Date.now(), bookingId);
      console.log(`[webhook] Stripe expired → ${bookingId} cancelled`);
    }
  }

  res.json({ received: true });
});

/**
 * GET /api/booking-status/:id
 * Polling από success.html
 */
app.get('/api/booking-status/:id', rateLimit(10_000, 20), (req, res) => {
  const id = req.params.id.replace(/[^A-Z0-9\-]/g, '').slice(0, 20);
  const b  = db.prepare(`
    SELECT id, name, seminar, status, confirmed_at, amount_cents FROM bookings WHERE id = ?
  `).get(id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json(b);
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Server on port ${PORT}`);
  const ll = getPoolAvailability('look_and_learn');
  const ws = getPoolAvailability('workshop');
  console.log(`✓ Look & Learn:          ${ll.available}/${ll.total} θέσεις`);
  console.log(`✓ Look & Learn Workshop: ${ws.available}/${ws.total} θέσεις`);
});
