(function () {
  // Αν έχει ήδη αποδεχτεί/απορρίψει, μην εμφανίσεις το banner
  if (localStorage.getItem('cookie_consent')) return;

  const styles = `
    #cookie-banner *{box-sizing:border-box;margin:0;padding:0}
    #cookie-banner{
      position:fixed;bottom:0;left:0;right:0;z-index:99999;
      background:#111;border-top:1px solid #2a2a2a;
      color:#d4cfc7;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;
      padding:20px 24px;
      box-shadow:0 -4px 24px rgba(0,0,0,.5);
      animation:slideUp .35s ease;
    }
    @keyframes slideUp{from{transform:translateY(100%);opacity:0}to{transform:translateY(0);opacity:1}}
    #cookie-banner .cb-inner{
      max-width:960px;margin:0 auto;
      display:flex;flex-wrap:wrap;align-items:center;gap:16px;
    }
    #cookie-banner .cb-text{flex:1;min-width:200px;line-height:1.6}
    #cookie-banner .cb-text strong{color:#fff;font-size:15px;display:block;margin-bottom:4px}
    #cookie-banner .cb-text a{color:#a0906e;text-decoration:underline;cursor:pointer}
    #cookie-banner .cb-buttons{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    #cookie-banner button{
      padding:10px 20px;border:none;border-radius:4px;
      cursor:pointer;font-size:13px;font-weight:600;letter-spacing:.04em;
      transition:opacity .2s;white-space:nowrap;
    }
    #cookie-banner button:hover{opacity:.85}
    #cookie-banner .cb-accept{background:#c9a96e;color:#0a0a0a}
    #cookie-banner .cb-reject{background:transparent;color:#d4cfc7;border:1px solid #444}
    #cookie-banner .cb-details{background:transparent;color:#888;border:none;font-size:12px;padding:10px 8px;text-decoration:underline}

    /* Modal */
    #cookie-modal{
      display:none;position:fixed;inset:0;z-index:100000;
      background:rgba(0,0,0,.75);align-items:center;justify-content:center;
    }
    #cookie-modal.open{display:flex}
    #cookie-modal .cm-box{
      background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;
      max-width:520px;width:90%;max-height:80vh;overflow-y:auto;
      padding:28px;color:#d4cfc7;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;
    }
    #cookie-modal .cm-box h2{color:#fff;font-size:18px;margin-bottom:16px}
    #cookie-modal .cm-category{
      border:1px solid #2a2a2a;border-radius:6px;padding:14px 16px;margin-bottom:12px;
    }
    #cookie-modal .cm-cat-header{
      display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;
    }
    #cookie-modal .cm-cat-header span{color:#fff;font-weight:600;font-size:14px}
    #cookie-modal .cm-category p{font-size:12px;color:#888;line-height:1.6}
    #cookie-modal .cm-toggle{
      position:relative;width:44px;height:24px;flex-shrink:0;
    }
    #cookie-modal .cm-toggle input{opacity:0;width:0;height:0}
    #cookie-modal .cm-slider{
      position:absolute;inset:0;background:#333;border-radius:24px;
      cursor:pointer;transition:.3s;
    }
    #cookie-modal .cm-slider:before{
      content:'';position:absolute;width:18px;height:18px;
      left:3px;top:3px;background:#888;border-radius:50%;transition:.3s;
    }
    #cookie-modal .cm-toggle input:checked+.cm-slider{background:#c9a96e}
    #cookie-modal .cm-toggle input:checked+.cm-slider:before{transform:translateX(20px);background:#fff}
    #cookie-modal .cm-toggle input:disabled+.cm-slider{opacity:.5;cursor:not-allowed}
    #cookie-modal .cm-modal-buttons{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}
    #cookie-modal .cm-modal-buttons button{
      padding:10px 20px;border:none;border-radius:4px;
      cursor:pointer;font-size:13px;font-weight:600;transition:opacity .2s;
    }
    #cookie-modal .cm-modal-buttons button:hover{opacity:.85}
    #cookie-modal .cm-save{background:#c9a96e;color:#0a0a0a;flex:1}
    #cookie-modal .cm-accept-all{background:#fff;color:#0a0a0a;flex:1}
    #cookie-modal .cm-close-modal{
      background:transparent;border:1px solid #444;color:#888;padding:10px 16px;
    }
  `;

  // Inject styles
  const styleEl = document.createElement('style');
  styleEl.textContent = styles;
  document.head.appendChild(styleEl);

  // Banner HTML
  const banner = document.createElement('div');
  banner.id = 'cookie-banner';
  banner.innerHTML = `
    <div class="cb-inner">
      <div class="cb-text">
        <strong>Σχετικά με τα Cookies</strong>
        Χρησιμοποιούμε cookies για την απρόσκοπτη λειτουργία της ιστοσελίδας.
        Με τη συγκατάθεσή σας, ενεργοποιούνται επιπλέον λειτουργίες.
        <a id="cb-details-link">Λεπτομέρειες</a>
      </div>
      <div class="cb-buttons">
        <button class="cb-details" id="cb-details-btn">Διαχείριση</button>
        <button class="cb-reject" id="cb-reject-btn">Απόρριψη</button>
        <button class="cb-accept" id="cb-accept-btn">Αποδοχή Όλων</button>
      </div>
    </div>
  `;
  document.body.appendChild(banner);

  // Modal HTML
  const modal = document.createElement('div');
  modal.id = 'cookie-modal';
  modal.innerHTML = `
    <div class="cm-box">
      <h2>Διαχείριση Cookies</h2>

      <div class="cm-category">
        <div class="cm-cat-header">
          <span>Αναγκαία Cookies</span>
          <label class="cm-toggle">
            <input type="checkbox" checked disabled>
            <span class="cm-slider"></span>
          </label>
        </div>
        <p>Απαραίτητα για τη βασική λειτουργία της σελίδας (πληρωμές, ασφάλεια). Δεν μπορούν να απενεργοποιηθούν.</p>
      </div>

      <div class="cm-category">
        <div class="cm-cat-header">
          <span>Στατιστικά Cookies</span>
          <label class="cm-toggle">
            <input type="checkbox" id="cm-stats">
            <span class="cm-slider"></span>
          </label>
        </div>
        <p>Μας βοηθούν να κατανοήσουμε πώς χρησιμοποιείτε την ιστοσελίδα, ανώνυμα.</p>
      </div>

      <div class="cm-category">
        <div class="cm-cat-header">
          <span>Διαφημιστικά Cookies</span>
          <label class="cm-toggle">
            <input type="checkbox" id="cm-marketing">
            <span class="cm-slider"></span>
          </label>
        </div>
        <p>Χρησιμοποιούνται για εξατομικευμένες διαφημίσεις και προωθητικές ενέργειες.</p>
      </div>

      <div class="cm-modal-buttons">
        <button class="cm-close-modal" id="cm-close">Κλείσιμο</button>
        <button class="cm-save" id="cm-save">Αποθήκευση Επιλογών</button>
        <button class="cm-accept-all" id="cm-accept-all">Αποδοχή Όλων</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  function hideBanner() {
    banner.style.animation = 'none';
    banner.style.transition = 'transform .3s ease, opacity .3s ease';
    banner.style.transform = 'translateY(100%)';
    banner.style.opacity = '0';
    setTimeout(() => banner.remove(), 350);
  }

  function saveConsent(stats, marketing) {
    localStorage.setItem('cookie_consent', JSON.stringify({
      necessary: true,
      stats: stats,
      marketing: marketing,
      date: new Date().toISOString()
    }));
    hideBanner();
    modal.classList.remove('open');
  }

  // Accept all
  document.getElementById('cb-accept-btn').addEventListener('click', () => saveConsent(true, true));
  document.getElementById('cm-accept-all').addEventListener('click', () => saveConsent(true, true));

  // Reject all
  document.getElementById('cb-reject-btn').addEventListener('click', () => saveConsent(false, false));

  // Open modal
  document.getElementById('cb-details-btn').addEventListener('click', () => modal.classList.add('open'));
  document.getElementById('cb-details-link').addEventListener('click', () => modal.classList.add('open'));

  // Save custom
  document.getElementById('cm-save').addEventListener('click', () => {
    const stats = document.getElementById('cm-stats').checked;
    const marketing = document.getElementById('cm-marketing').checked;
    saveConsent(stats, marketing);
  });

  // Close modal
  document.getElementById('cm-close').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });
})();
