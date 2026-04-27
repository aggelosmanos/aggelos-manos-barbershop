/**
 * Aggelos Manos Mens Salon — Booking Backend v4 (PostgreSQL)
 * Δύο σεμινάρια με cross-decrement λογική:
 *   - Look & Learn:           94 θέσεις
 *   - Look & Learn Workshop:   6 θέσεις (κάθε κράτηση -1 και από τα 150)
 *
 * npm install express stripe pg nodemailer dotenv cors
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const Stripe     = require('stripe');
const { Pool }   = require('pg');
const crypto     = require('crypto');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const pool   = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
const CONFIG = {
  TIMEOUT_MINUTES: 30,
  FRONTEND_URL: process.env.FRONTEND_URL,
};

const SEMINARS = {
  'Look & Learn': {
    label:           'Look & Learn',
    amount:          3000,          // 30.00€ προκαταβολή
    seats_key:       'look_and_learn',
    also_decrements: [],
  },
  'Look & Learn Workshop': {
    label:           'Look & Learn Workshop',
    amount:          5000,          // 50.00€ προπληρωμή
    seats_key:       'workshop',
    also_decrements: ['look_and_learn'],
  },
};

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS seat_pools (
        id          TEXT    PRIMARY KEY,
        label       TEXT    NOT NULL,
        total_seats INTEGER NOT NULL,
        version     INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO seat_pools (id, label, total_seats) VALUES
        ('look_and_learn', 'Look & Learn',          89),
        ('workshop',       'Look & Learn Workshop',  6)
      ON CONFLICT (id) DO UPDATE SET total_seats = EXCLUDED.total_seats;

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
        created_at        BIGINT  NOT NULL,
        expires_at        BIGINT  NOT NULL,
        confirmed_at      BIGINT,
        cancelled_at      BIGINT,
        cancel_reason     TEXT,
        invoice_data      TEXT
      );

      CREATE TABLE IF NOT EXISTS booking_seat_locks (
        booking_id TEXT NOT NULL,
        pool_id    TEXT NOT NULL,
        PRIMARY KEY (booking_id, pool_id)
      );

      CREATE INDEX IF NOT EXISTS idx_bookings_status  ON bookings(status);
      CREATE INDEX IF NOT EXISTS idx_bookings_email   ON bookings(email, seminar, status);
      CREATE INDEX IF NOT EXISTS idx_bookings_expires ON bookings(expires_at) WHERE status='pending';
    `);
    console.log('✓ Database initialized');
  } finally {
    client.release();
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function generateBookingId() {
  return 'AM-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

async function getPoolAvailability(client, poolId) {
  const poolRes = await client.query('SELECT * FROM seat_pools WHERE id = $1', [poolId]);
  const p = poolRes.rows[0];
  const now = Date.now();

  const pendingRes = await client.query(`
    SELECT COUNT(*) as cnt
    FROM bookings b
    JOIN booking_seat_locks l ON l.booking_id = b.id
    WHERE l.pool_id = $1 AND b.status = 'pending' AND b.expires_at > $2
  `, [poolId, now]);

  const confirmedRes = await client.query(`
    SELECT COUNT(*) as cnt
    FROM bookings b
    JOIN booking_seat_locks l ON l.booking_id = b.id
    WHERE l.pool_id = $1 AND b.status = 'confirmed'
  `, [poolId]);

  const pending   = parseInt(pendingRes.rows[0].cnt);
  const confirmed = parseInt(confirmedRes.rows[0].cnt);

  return {
    id:        poolId,
    label:     p.label,
    total:     p.total_seats,
    confirmed,
    pending,
    available: Math.max(0, p.total_seats - confirmed - pending),
  };
}

async function reserveSeats(bookingId, name, email, phone, seminar, message, amount, expiresAt, invoiceData) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const seminarDef = SEMINARS[seminar];
    const poolsToLock = [seminarDef.seats_key, ...seminarDef.also_decrements];
    const now = Date.now();

    // 1. Έλεγχος διαθεσιμότητας
    for (const poolId of poolsToLock) {
      const avail = await getPoolAvailability(client, poolId);
      if (avail.available <= 0) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'no_seats', pool: poolId, label: avail.label };
      }
    }

    // 3. Insert κράτηση
    await client.query(`
      INSERT INTO bookings
        (id, name, email, phone, seminar, message, amount_cents, status, created_at, expires_at, invoice_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10)
    `, [bookingId, name, email, phone, seminar, message || '', amount, now, expiresAt, invoiceData || null]);

    // 4. Καταγραφή pools
    for (const poolId of poolsToLock) {
      await client.query(`
        INSERT INTO booking_seat_locks (booking_id, pool_id) VALUES ($1,$2)
      `, [bookingId, poolId]);
    }

    await client.query('COMMIT');
    return { ok: true, lockedPools: poolsToLock };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── EMAIL ────────────────────────────────────────────────────────────────────
async function sendConfirmationEmail(booking) {
  if (!process.env.RESEND_API_KEY) return;
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const ownerEmail = process.env.OWNER_EMAIL || 'axillews133@gmail.com';
  const FROM = 'Aggelos Manos Mens Salon <info@aggelosmanosmenssalon.gr>';

  // Email στον πελάτη
  await resend.emails.send({
    from: FROM,
    to: [booking.email],
    subject: `✓ Επιβεβαίωση Κράτησης ${booking.id}`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a0a0a;color:#f0ebe0;border:1px solid #333">
        <div style="text-align:center;margin-bottom:24px">
          <img src="https://aggelosmanosmenssalon.gr/images/artistic-minds.jpg" alt="Artistic Minds Seminars" style="width:100px;height:100px;border-radius:50%;object-fit:cover;display:inline-block"/>
        </div>
        <h2 style="color:#fff">✓ Η κράτησή σας επιβεβαιώθηκε!</h2>
        <div style="text-align:center;margin:24px 0;padding:20px;background:#111;border:1px solid #333;border-radius:4px">
          <p style="font-size:.72rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.4);margin-bottom:12px">Εισιτήριο Εισόδου</p>
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=https://aggelosmanosmenssalon.gr/verify.html?id=${booking.id}&bgcolor=111111&color=ffffff&margin=10" alt="QR Code" style="display:inline-block;border-radius:4px"/>
          <p style="font-family:monospace;font-size:1.1rem;font-weight:700;color:#fff;letter-spacing:.15em;margin-top:12px">${booking.id}</p>
          <p style="font-size:.72rem;color:rgba(255,255,255,.35);margin-top:6px">Παρουσιάστε αυτό το QR code την ημέρα του σεμιναρίου</p>
        </div>
        <table style="width:100%;margin-top:20px">
          <tr><td style="color:#888;padding:6px 0">Κωδικός</td>   <td style="color:#fff;font-weight:bold">${booking.id}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Σεμινάριο</td> <td style="color:#fff">${booking.seminar}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Όνομα</td>     <td style="color:#fff">${booking.name}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Ποσό</td>      <td style="color:#fff">${(booking.amount_cents/100).toFixed(2)}€</td></tr>
          <tr><td style="color:#888;padding:6px 0">Τοποθεσία</td><td style="color:#fff">Park Hotel<br><span style="font-size:.85rem;color:#aaa">Δεληγιώργη 2, Βόλος</span></td></tr>
        </table>
        <div style="margin-top:24px;padding-top:20px;border-top:1px solid #222">
          <p style="font-size:.68rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.3);margin-bottom:10px">Πολιτική Σεμιναρίου</p>
          <p style="font-size:.78rem;color:#666;line-height:1.8">Οι κρατήσεις πραγματοποιούνται κατόπιν προκαταβολής, η οποία καταβάλλεται κατά την επιβεβαίωση της κράτησης. Το υπόλοιπο ποσό εξοφλείται την ημέρα της παροχής της υπηρεσίας σε μετρητά.</p>
        </div>
        <p style="margin-top:16px;color:#888;font-size:13px">Για περισσότερες πληροφορίες καλέστε στο 6987 033949</p>
      </div>
    `,
  });

  // Email στον ιδιοκτήτη
  await resend.emails.send({
    from: FROM,
    to: [ownerEmail],
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
          <tr><td style="color:#888;padding:6px 0">Τοποθεσία</td>  <td style="color:#fff">Park Hotel<br><span style="font-size:.85rem;color:#aaa">Δεληγιώργη 2, Βόλος</span></td></tr>
        </table>
        ${(() => { if (!booking.invoice_data) return ''; const inv = JSON.parse(booking.invoice_data); return '<div style="margin-top:20px;padding:14px 16px;background:#111;border:1px solid #b8860b;border-radius:4px;"><p style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#b8860b;margin:0 0 10px;">&#9888; Ζητείται Τιμολόγιο</p><table style="width:100%;font-size:13px;"><tr><td style="color:#888;padding:4px 0;">Επωνυμία</td><td style="color:#fff;">' + (inv.company||'—') + '</td></tr><tr><td style="color:#888;padding:4px 0;">ΑΦΜ</td><td style="color:#fff;">' + (inv.vat||'—') + '</td></tr><tr><td style="color:#888;padding:4px 0;">ΔΟΥ</td><td style="color:#fff;">' + (inv.tax_office||'—') + '</td></tr><tr><td style="color:#888;padding:4px 0;">Διεύθυνση</td><td style="color:#fff;">' + (inv.address||'—') + '</td></tr></table></div>'; })()}
      </div>
    `,
  });
}

// ─── CLEANUP ──────────────────────────────────────────────────────────────────
async function cleanupExpiredBookings() {
  const now = Date.now();
  const res = await pool.query(`
    UPDATE bookings
    SET status = 'cancelled', cancelled_at = $1, cancel_reason = 'timeout'
    WHERE status = 'pending' AND expires_at < $2
  `, [now, now]);
  if (res.rowCount > 0) {
    console.log(`[cleanup] ${res.rowCount} expired booking(s) cancelled`);
  }
}

setInterval(cleanupExpiredBookings, 60_000);

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' }));

const ALLOWED_ORIGINS = [
  'https://aggelosmanosmenssalon.gr',
  'https://www.aggelosmanosmenssalon.gr',
  'https://aggelosmanos.github.io',
  CONFIG.FRONTEND_URL,
].filter(Boolean);

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
app.get('/api/availability', rateLimit(10_000, 20), async (req, res) => {
  const client = await pool.connect();
  try {
    res.json({
      look_and_learn: await getPoolAvailability(client, 'look_and_learn'),
      workshop:       await getPoolAvailability(client, 'workshop'),
    });
  } catch (err) {
    console.error('[availability]', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.post('/api/create-booking', rateLimit(60_000, 5), async (req, res) => {
  try {
    const { name, email, phone, seminar, message } = req.body;

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

    const invoiceData = req.body.invoice ? JSON.stringify(req.body.invoice) : null;
    const result = await reserveSeats(
      bookingId, name.trim(), email.trim(), phone.trim(),
      seminar, message?.trim(), seminarDef.amount, expiresAt, invoiceData
    );

    if (!result.ok) {
      if (result.reason === 'no_seats') {
        const msg = result.pool === 'workshop'
          ? 'Δεν υπάρχουν διαθέσιμες θέσεις για το Workshop.'
          : 'Δεν υπάρχουν διαθέσιμες θέσεις για το Look & Learn.';
        return res.status(409).json({ error: msg });
      }
      if (result.reason === 'duplicate') {
        // Βρες την υπάρχουσα κράτηση
        const existingRes = await pool.query(
          'SELECT id, stripe_session_id, expires_at FROM bookings WHERE id = $1',
          [result.bookingId]
        );
        const existing = existingRes.rows[0];

        // Αν έχει ανοιχτό Stripe session → στείλε τον εκεί (δεν κλείνει νέα θέση)
        if (existing?.stripe_session_id) {
          try {
            const existingSession = await stripe.checkout.sessions.retrieve(existing.stripe_session_id);
            if (existingSession.status === 'open') {
              return res.json({ sessionUrl: existingSession.url, bookingId: existing.id, redirecting: true, expiresAt: Number(existing.expires_at) });
            }
          } catch(e) {}
        }

        // Το session έχει λήξει → ακύρωσε την παλιά (η θέση παραμένει δεσμευμένη)
        // και φτιάξε νέο Stripe session για την ίδια κράτηση
        const newExpiresAt = Date.now() + CONFIG.TIMEOUT_MINUTES * 60_000;
        await pool.query(
          'UPDATE bookings SET expires_at=$1 WHERE id=$2',
          [newExpiresAt, existing.id]
        );
        const renewedSession = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'payment',
          line_items: [{ price_data: { currency: 'eur', product_data: { name: `Σεμινάριο: ${seminarDef.label}`, description: `Κράτηση #${existing.id} — Aggelos Manos Mens Salon` }, unit_amount: seminarDef.amount }, quantity: 1 }],
          customer_email: email,
          metadata: { bookingId: existing.id, name, phone, seminar },
          success_url: `${CONFIG.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&booking_id=${existing.id}`,
          cancel_url: `${CONFIG.FRONTEND_URL}/?cancelled=1#booking-seminar`,
          expires_at: Math.floor(newExpiresAt / 1000),
          payment_intent_data: { description: `Κράτηση #${existing.id}`, metadata: { bookingId: existing.id } },
        });
        await pool.query('UPDATE bookings SET stripe_session_id=$1 WHERE id=$2', [renewedSession.id, existing.id]);
        return res.json({ sessionUrl: renewedSession.url, bookingId: existing.id, redirecting: true, expiresAt: newExpiresAt });
      }
    }

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
        invoice_creation: { enabled: true },
        success_url: `${CONFIG.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&booking_id=${bookingId}`,
        cancel_url:  `${CONFIG.FRONTEND_URL}/?cancelled=1#booking-seminar`,
        expires_at:  Math.floor(expiresAt / 1000),
        payment_intent_data: {
          description: `Κράτηση #${bookingId}`,
          metadata: { bookingId },
        },
      });
    } catch (stripeErr) {
      await pool.query(`
        UPDATE bookings SET status='cancelled', cancelled_at=$1, cancel_reason='stripe_error' WHERE id=$2
      `, [Date.now(), bookingId]);
      console.error('[create-booking] Stripe error:', stripeErr.message);
      return res.status(502).json({ error: 'Σφάλμα Stripe. Δοκιμάστε ξανά.' });
    }

    await pool.query('UPDATE bookings SET stripe_session_id = $1 WHERE id = $2', [session.id, bookingId]);

    console.log(`[create-booking] ${bookingId} | ${seminar} | pools: ${result.lockedPools.join(', ')}`);
    res.json({ sessionUrl: session.url, bookingId });

  } catch (err) {
    console.error('[create-booking]', err);
    res.status(500).json({ error: 'Σφάλμα διακομιστή.' });
  }
});

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

    const bookingRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    const booking = bookingRes.rows[0];
    if (!booking) return res.json({ received: true });
    if (booking.status === 'confirmed') return res.json({ received: true });

    if (booking.status === 'cancelled') {
      console.warn(`[webhook] ALERT: Payment for cancelled booking ${bookingId}`);
      return res.json({ received: true });
    }

    await pool.query(`
      UPDATE bookings SET status='confirmed', confirmed_at=$1 WHERE id=$2 AND status='pending'
    `, [Date.now(), bookingId]);

    console.log(`[webhook] Confirmed: ${bookingId} | seminar: ${booking.seminar}`);
    try { await sendConfirmationEmail(booking); } catch (e) { console.error('[webhook] Email error:', e.message); }
  }

  if (event.type === 'checkout.session.expired') {
    const bookingId = event.data.object.metadata?.bookingId;
    if (bookingId) {
      await pool.query(`
        UPDATE bookings SET status='cancelled', cancelled_at=$1, cancel_reason='stripe_expired'
        WHERE id=$2 AND status='pending'
      `, [Date.now(), bookingId]);
      console.log(`[webhook] Stripe expired → ${bookingId} cancelled`);
    }
  }

  res.json({ received: true });
});

app.get('/api/booking-status/:id', rateLimit(10_000, 20), async (req, res) => {
  const id = req.params.id.replace(/[^A-Z0-9\-]/g, '').slice(0, 20);
  const result = await pool.query(`
    SELECT id, name, seminar, status, confirmed_at, amount_cents FROM bookings WHERE id = $1
  `, [id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(result.rows[0]);
});

/**
 * GET /api/verify/:id?pin=XXXX
 * Επαλήθευση κράτησης για σκανάρισμα QR
 */
app.get('/api/verify/:id', async (req, res) => {
  const pin = req.query.pin;
  if (pin !== process.env.VERIFY_PIN) {
    return res.status(401).json({ error: 'Μη εξουσιοδοτημένη πρόσβαση.' });
  }
  const id = req.params.id.replace(/[^A-Z0-9\-]/g, '').slice(0, 20);
  const result = await pool.query(`
    SELECT id, name, seminar, status, confirmed_at, amount_cents FROM bookings WHERE id = $1
  `, [id]);
  if (!result.rows[0]) return res.status(404).json({ valid: false, error: 'Δεν βρέθηκε κράτηση.' });
  const b = result.rows[0];
  res.json({
    valid: b.status === 'confirmed',
    id: b.id,
    name: b.name,
    seminar: b.seminar,
    status: b.status,
    amount: (b.amount_cents / 100).toFixed(2) + '€',
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(async () => {
  const client = await pool.connect();
  try {
    const ll = await getPoolAvailability(client, 'look_and_learn');
    const ws = await getPoolAvailability(client, 'workshop');
    app.listen(PORT, () => {
      console.log(`✓ Server on port ${PORT}`);
      console.log(`✓ Look & Learn:          ${ll.available}/${ll.total} θέσεις`);
      console.log(`✓ Look & Learn Workshop: ${ws.available}/${ws.total} θέσεις`);
    });
    cleanupExpiredBookings();
  } finally {
    client.release();
  }
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
