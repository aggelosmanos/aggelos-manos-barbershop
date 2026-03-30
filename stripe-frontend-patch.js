/**
 * ΑΝΤΙΚΑΤΑΣΤΑΣΗ submitForm() στο index.html
 *
 * Βρες την παλιά συνάρτηση submitForm(event) και αντικατέστησέ την με αυτή.
 * Επίσης αντικατέστησε το #vivaPayBtn block με το παρακάτω HTML.
 */

// ─── HTML: Αντικατάσταση του Viva Wallet block (γύρω από γραμμή 1023) ────────
/*
  ΔΙΑΓΡΑΨΕ αυτό:
  ─────────────────────────────────────────────────
  <!-- Viva Wallet -->
  <a href="#" class="sf-pay-btn" id="vivaPayBtn">
    ...Online Πληρωμή — Viva Wallet...
  </a>
  <p class="sf-pay-secure">
    ...Ασφαλής πληρωμή · Visa · Mastercard · IRIS...
  </p>
  ─────────────────────────────────────────────────

  ΒΑΛΕ αυτό:
  ─────────────────────────────────────────────────
  <p class="sf-pay-secure" style="margin-top:12px">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
    Ασφαλής πληρωμή μέσω Stripe · Visa · Mastercard
  </p>
  ─────────────────────────────────────────────────
*/

// ─── JS: Νέα submitForm() ──────────────────────────────────────────────────────
async function submitForm(event) {
  event.preventDefault();

  const form    = event.target;
  const btn     = form.querySelector('button[type=submit]');
  const success = document.getElementById('form-success');

  // Disable button + loading state
  btn.textContent = 'Επεξεργασία...';
  btn.disabled = true;
  success.style.display = 'none';

  const data = Object.fromEntries(new FormData(form));

  try {
    const res = await fetch('/api/create-booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    const json = await res.json();

    if (!res.ok) {
      // Server-side validation error (duplicate booking, invalid seminar, κτλ)
      alert('⚠️ ' + (json.error || 'Παρουσιάστηκε σφάλμα. Δοκιμάστε ξανά.'));
      btn.textContent = 'Ολοκλήρωση Κράτησης →';
      btn.disabled = false;
      return;
    }

    // Επιτυχία — redirect αμέσως στο Stripe Checkout
    // Ο χρήστης δεν έχει χρόνο να κάνει back
    success.innerHTML = `
      <div style="margin-bottom:8px">✓ Κράτηση δημιουργήθηκε!</div>
      <span style="font-size:.78rem;color:rgba(255,255,255,.6)">Μεταφορά στη σελίδα πληρωμής...</span>
    `;
    success.style.display = 'block';
    btn.style.display = 'none';

    // Σύντομη καθυστέρηση για να δει ο χρήστης το μήνυμα, μετά hard redirect
    setTimeout(() => {
      window.location.href = json.sessionUrl; // Stripe Checkout — αντικαθιστά το history entry
    }, 800);

  } catch (err) {
    console.error('[submitForm]', err);
    alert('Σφάλμα σύνδεσης. Ελέγξτε το internet σας και δοκιμάστε ξανά.');
    btn.textContent = 'Ολοκλήρωση Κράτησης →';
    btn.disabled = false;
  }
}

// ─── ΠΡΟΣΘΕΣΕ ΑΥΤΟ — αλλαγή κειμένου του submit button ─────────────────────
// Βρες το button στη γραμμή ~1007 και άλλαξε το κείμενο από:
//   "Αποστολή Αίτησης →"
// σε:
//   "Ολοκλήρωση Κράτησης →"
