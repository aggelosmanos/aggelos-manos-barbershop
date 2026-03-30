/**
 * ════════════════════════════════════════════════════════════
 *  ΟΔΗΓΙΕΣ: Τι αλλάζεις στο index.html
 * ════════════════════════════════════════════════════════════
 *
 * 1. Πρόσθεσε το seat counter HTML πριν ή μέσα στη φόρμα
 * 2. Αντικατέστησε την submitForm()
 * 3. Αντικατέστησε το Viva Wallet block
 * 4. Πρόσθεσε το polling script
 * ════════════════════════════════════════════════════════════
 */


// ════════════════════════════════════════════════════════════
// 1. HTML — SEAT COUNTER
//    Πρόσθεσε αυτό στη γραμμή ~958, μέσα στο .sf-left div,
//    μετά το .sf-info block:
// ════════════════════════════════════════════════════════════
/*
<div class="seat-counter" id="seatCounter">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="1.5"
       stroke-linecap="round" stroke-linejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
  Υπολειπόμενες θέσεις:
  <span id="seatsAvailable">—</span>
  <span class="seat-counter-total">/ 150</span>
</div>
*/

// CSS — πρόσθεσε στο <style> του index.html:
/*
.seat-counter {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
  padding: 12px 16px;
  background: rgba(255,255,255,.04);
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 2px;
  font-family: var(--f-body);
  font-size: .78rem;
  color: rgba(255,255,255,.65);
  letter-spacing: .04em;
}
.seat-counter svg { color: rgba(255,255,255,.4); flex-shrink: 0; }
#seatsAvailable {
  font-weight: 700;
  color: #fff;
  font-size: .95rem;
  min-width: 28px;
}
#seatsAvailable.low   { color: #f59e0b; } /* κίτρινο αν < 20  */
#seatsAvailable.empty { color: #ef4444; } /* κόκκινο αν = 0   */
.seat-counter-total { color: rgba(255,255,255,.3); }
*/


// ════════════════════════════════════════════════════════════
// 2. HTML — Αντικατάσταση Viva Wallet block (γύρω στη γραμμή 1023)
//    Διέγραψε το <a href="#" class="sf-pay-btn" id="vivaPayBtn">
//    και το <p class="sf-pay-secure"> που ακολουθεί.
//    Βάλε αντί αυτού:
// ════════════════════════════════════════════════════════════
/*
<p class="sf-pay-secure" style="margin-top:12px">
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
  Ασφαλής πληρωμή μέσω Stripe · Visa · Mastercard
</p>
*/


// ════════════════════════════════════════════════════════════
// 3. JS — Νέα submitForm() — αντικατέστησε την παλιά
// ════════════════════════════════════════════════════════════

async function submitForm(event) {
  event.preventDefault();

  const form    = event.target;
  const btn     = form.querySelector('button[type=submit]');
  const success = document.getElementById('form-success');

  btn.textContent = 'Επεξεργασία...';
  btn.disabled    = true;
  success.style.display = 'none';

  const data = Object.fromEntries(new FormData(form));

  try {
    const res  = await fetch('/api/create-booking', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    const json = await res.json();

    if (!res.ok) {
      alert('⚠️ ' + (json.error || 'Παρουσιάστηκε σφάλμα. Δοκιμάστε ξανά.'));
      btn.textContent = 'Ολοκλήρωση Κράτησης →';
      btn.disabled    = false;
      fetchAvailability(); // ανανέωσε το counter
      return;
    }

    // Επιτυχία — δείξε σύντομο μήνυμα και redirect αμέσως
    success.innerHTML = `
      <div style="margin-bottom:6px">✓ Κράτηση δημιουργήθηκε!</div>
      <span style="font-size:.78rem;color:rgba(255,255,255,.55)">
        Μεταφορά στη σελίδα πληρωμής...
      </span>
    `;
    success.style.display = 'block';
    btn.style.display     = 'none';

    // Χρησιμοποιούμε replace() αντί για href= για να μην μπει στο history
    setTimeout(() => {
      window.location.replace(json.sessionUrl);
    }, 700);

  } catch (err) {
    console.error('[submitForm]', err);
    alert('Σφάλμα σύνδεσης. Ελέγξτε το internet σας και δοκιμάστε ξανά.');
    btn.textContent = 'Ολοκλήρωση Κράτησης →';
    btn.disabled    = false;
  }
}


// ════════════════════════════════════════════════════════════
// 4. JS — Seat availability polling
//    Πρόσθεσε αυτό μέσα στο <script> του index.html
//    (κοντά στο τέλος, πριν το closing </script>)
// ════════════════════════════════════════════════════════════

const API_BASE = ''; // π.χ. 'https://api.yourdomain.gr' αν ο server είναι σε άλλο domain

async function fetchAvailability() {
  try {
    const res  = await fetch(`${API_BASE}/api/availability`);
    if (!res.ok) return;
    const data = await res.json();

    const el = document.getElementById('seatsAvailable');
    if (!el) return;

    el.textContent  = data.available;
    el.className    = data.available === 0 ? 'empty' : data.available < 20 ? 'low' : '';

    // Αν δεν υπάρχουν θέσεις, απενεργοποίησε το submit button
    const submitBtn = document.querySelector('.seminar-form button[type=submit]');
    if (submitBtn && data.available === 0) {
      submitBtn.disabled    = true;
      submitBtn.textContent = 'Δεν υπάρχουν διαθέσιμες θέσεις';
      submitBtn.style.opacity = '0.5';
    }
  } catch (e) {
    // Silent fail — δεν θέλουμε να σπάσει η σελίδα αν ο server δεν αποκρίνεται
  }
}

// Φόρτωσε αμέσως + polling κάθε 15 δευτερόλεπτα
fetchAvailability();
setInterval(fetchAvailability, 15_000);

// Ανανέωσε όταν ο χρήστης ανοίξει τη φόρμα σεμιναρίου
// (αν χρησιμοποιείς openModal() για το seminar-form)
const _origOpenModal = window.openModal;
if (typeof _origOpenModal === 'function') {
  window.openModal = function(id) {
    _origOpenModal(id);
    if (id === 'seminar-form') fetchAvailability();
  };
}
