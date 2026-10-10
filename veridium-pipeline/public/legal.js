// Fills in the contact address on the legal pages from the server's CONTACT_EMAIL setting.
(async () => {
  let email = null;
  try {
    email = (await (await fetch('/api/legal')).json()).contactEmail;
  } catch {}
  for (const el of document.querySelectorAll('[data-contact]')) {
    const link = el.querySelector('[data-contact-email]');
    if (email && link) {
      link.href = `mailto:${email}`;
      link.textContent = email;
    } else {
      el.textContent = 'Contact details for privacy and account requests will be listed here. Until then, you can delete your account yourself from Account settings.';
    }
  }
})();
