// =============================================
//  AGGELOS MANOS BARBERSHOP — script.js
// =============================================

// ---- Navbar: add 'scrolled' class on scroll ----
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  if (window.scrollY > 60) {
    navbar.classList.add('scrolled');
  } else {
    navbar.classList.remove('scrolled');
  }
}, { passive: true });

// ---- Hamburger menu ----
const hamburger = document.getElementById('hamburger');
const navLinks  = document.getElementById('navLinks');

hamburger.addEventListener('click', () => {
  navLinks.classList.toggle('open');
  hamburger.classList.toggle('active');
});

// Close menu when a link is clicked
navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('open');
    hamburger.classList.remove('active');
  });
});

// Close menu when clicking outside
document.addEventListener('click', (e) => {
  if (!navbar.contains(e.target)) {
    navLinks.classList.remove('open');
    hamburger.classList.remove('active');
  }
});

// ---- Hamburger animation ----
const style = document.createElement('style');
style.textContent = `
  .hamburger.active span:nth-child(1) { transform: rotate(45deg) translate(5px, 5px); }
  .hamburger.active span:nth-child(2) { opacity: 0; transform: translateX(-10px); }
  .hamburger.active span:nth-child(3) { transform: rotate(-45deg) translate(5px, -5px); }
`;
document.head.appendChild(style);

// ---- Intersection Observer: fade-in sections ----
const observerOptions = {
  threshold: 0.12,
  rootMargin: '0px 0px -40px 0px'
};

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, observerOptions);

// Add animation classes
const animStyle = document.createElement('style');
animStyle.textContent = `
  .animate-fade {
    opacity: 0;
    transform: translateY(36px);
    transition: opacity 0.75s ease, transform 0.75s ease;
  }
  .animate-fade.visible {
    opacity: 1;
    transform: translateY(0);
  }
  .animate-fade:nth-child(2) { transition-delay: 0.1s; }
  .animate-fade:nth-child(3) { transition-delay: 0.2s; }
  .animate-fade:nth-child(4) { transition-delay: 0.3s; }
`;
document.head.appendChild(animStyle);

// Apply to elements
document.querySelectorAll(
  '.service-card, .price-row, .badge, .contact-list li, .about-desc'
).forEach(el => {
  el.classList.add('animate-fade');
  observer.observe(el);
});

// ---- Smooth active nav link highlighting ----
const sections = document.querySelectorAll('section[id]');
const navAnchors = document.querySelectorAll('.nav-links a');

window.addEventListener('scroll', () => {
  let current = '';
  sections.forEach(section => {
    const sectionTop = section.offsetTop - 120;
    if (window.scrollY >= sectionTop) {
      current = section.getAttribute('id');
    }
  });

  navAnchors.forEach(a => {
    a.style.color = '';
    if (a.getAttribute('href') === `#${current}`) {
      a.style.color = 'var(--gold)';
    }
  });
}, { passive: true });
