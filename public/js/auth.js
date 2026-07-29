// Populates the user chip in the topbar and wires the sign-out button.
// If /api/auth/me returns 401 (session expired / cookie cleared),
// bounce to /login.html so the app never renders a stale, unauthenticated view.
(function () {
  const chip = document.getElementById('userChip');
  const nameEl = document.getElementById('userName');
  const emailEl = document.getElementById('userEmail');
  const btn = document.getElementById('logoutBtn');

  fetch('/api/auth/me', { credentials: 'same-origin' })
    .then(r => {
      if (r.status === 401) { window.location.replace('/login.html'); return null; }
      return r.json();
    })
    .then(me => {
      if (!me) return;
      if (nameEl) nameEl.textContent = me.name || me.email;
      if (emailEl) emailEl.textContent = me.email;
      if (chip) chip.hidden = false;
    })
    .catch(() => {});

  if (btn) {
    btn.addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (e) { /* ignore */ }
      window.location.replace('/login.html');
    });
  }
})();
