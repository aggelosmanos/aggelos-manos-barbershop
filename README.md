# Aggelos Manos BarberShop – Website

## 📁 Δομή Αρχείων

```
aggelos-manos-barbershop/
├── index.html          ← Κύρια σελίδα
├── style.css           ← Όλα τα στυλ
├── script.js           ← JavaScript (navbar, animations)
├── images/
│   ├── hero-bg.jpg     ← Κύρια background εικόνα hero section
│   ├── barber-1.jpg    ← Φωτογραφία για "Σχετικά με εμάς"
│   ├── price-bg.jpg    ← Background για τιμοκατάλογο
│   └── .gitkeep
└── README.md           ← Αυτό το αρχείο
```

## 🖼️ Εικόνες (Σημαντικό!)

Για να δουλέψει σωστά το site, χρειάζεσαι να προσθέσεις τις παρακάτω εικόνες στον φάκελο `images/`:

| Αρχείο | Περιγραφή | Προτεινόμενες διαστάσεις |
|--------|-----------|--------------------------|
| `hero-bg.jpg` | Κύρια εικόνα hero (εσωτερικό κουρείου ή barber σε δουλειά) | 1920×1080px |
| `barber-1.jpg` | Πορτρέτο barber ή εσωτερικό | 800×1000px |
| `price-bg.jpg` | Background τιμοκαταλόγου (σκούρα, με texture) | 1920×800px |

### 🆓 Δωρεάν εικόνες (Unsplash)
Μπορείς να χρησιμοποιήσεις εικόνες από:
- https://unsplash.com/s/photos/barbershop
- https://unsplash.com/s/photos/barber
- https://www.pexels.com/search/barber%20shop/

## 🚀 Deploy στο GitHub Pages

1. Δημιούργησε νέο repository στο GitHub (π.χ. `aggelos-manos-barbershop`)
2. Upload όλα τα αρχεία
3. Πήγαινε **Settings → Pages**
4. Source: **Deploy from a branch** → `main` / `root`
5. Το site θα είναι διαθέσιμο σε: `https://USERNAME.github.io/aggelos-manos-barbershop/`

## ✏️ Προσαρμογή

### Τηλέφωνο
Ψάξε και άλλαξε όλες τις εμφανίσεις του `+302310000000` και `2310 000 000` στα `index.html` και `script.js`.

### Διεύθυνση
Στο `index.html` άλλαξε: `Τσιμισκή 00, Θεσσαλονίκη 54624`

### Online Ραντεβού
Το κουμπί "ONLINE ΡΑΝΤΕΒΟΥ" ανοίγει WhatsApp. Άλλαξε τον αριθμό στο href:
```html
href="https://wa.me/302310000000?text=..."
```
Ή άλλαξε σε booking platform (π.χ. Treatwell, Fresha):
```html
href="https://www.fresha.com/your-barbershop-link"
```

### Χάρτης Google Maps
Άλλαξε το `src` του `<iframe>` στο contact section με τον πραγματικό embed link.

### Social Media
Άλλαξε τα `href="#"` στα social buttons με τα πραγματικά links.
