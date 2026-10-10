// Shared site header for every page: logo, search, icon nav, and the account menu.
// A page sets <body data-page="home|players|organizations|tournaments|jobs|landing|login"> and has <header id="site-header">.
// The logged-in account comes from the session cookie (GET /api/auth/me). A copy is cached locally so
// pages can render right away; if the server disagrees (logged out elsewhere, session expired) the page reloads.
(() => {
  const ACCOUNT_KEY = 'veridium.account';
  try { localStorage.removeItem('veridium.lastRiotId'); } catch {} // the pre-accounts "me" key
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    players: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
    organizations: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M10 21v-4h4v4"/>',
    tournaments: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 5H4v2a3 3 0 0 0 4 3M16 5h4v2a3 3 0 0 1-4 3M12 13v4M8 21h8M9 17h6"/>',
    jobs: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  };
  const NAV = [
    ['home', 'Home', '/'],
    ['players', 'Players', 'players.html'],
    ['organizations', 'Organizations', 'organizations.html'],
    ['tournaments', 'Tournaments', 'tournaments.html'],
    ['jobs', 'Jobs', 'jobs.html'],
  ];
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** The logged-in account ({ email, player, adminOf }) or null. */
  function getAccount() {
    try {
      const a = JSON.parse(localStorage.getItem(ACCOUNT_KEY));
      return a && a.email ? a : null;
    } catch {
      return null;
    }
  }
  /** The logged-in account's linked Riot ID ({ riotId, region }), or null. */
  function getMe() {
    const p = getAccount()?.player;
    return p ? { riotId: p.riotId, region: p.region } : null;
  }
  function cacheAccount(user) {
    try {
      if (user) {
        const { email, player, adminOf, termsAccepted } = user;
        localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ email, player, adminOf, termsAccepted }));
      }
      else localStorage.removeItem(ACCOUNT_KEY);
    } catch {}
  }

  /** Re-read the session from the server. Reloads the page if who's logged in changed. */
  async function refreshAccount({ reloadOnChange = true } = {}) {
    const before = JSON.stringify(getAccount());
    let user;
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) return getAccount();
      user = (await res.json()).user;
    } catch {
      return getAccount(); // offline: keep the cached view
    }
    cacheAccount(user);
    const changed = before !== JSON.stringify(getAccount());
    if (changed && reloadOnChange && document.body.dataset.page !== 'login') location.reload();
    else render();
    termsGate(getAccount());
    return getAccount();
  }

  // An account that hasn't accepted the current Terms and Privacy Policy can't do anything that needs a
  // login (the API answers 403 terms_required), so ask before anything else. The legal pages stay readable.
  function termsGate(account) {
    document.querySelector('.terms-gate')?.remove();
    if (!account || account.termsAccepted !== false || document.body.dataset.page === 'legal') return;
    const gate = document.createElement('div');
    gate.className = 'terms-gate';
    gate.innerHTML = `<div class="box" role="dialog" aria-modal="true" aria-labelledby="termsTitle" aria-describedby="termsText">
        <h2 id="termsTitle">Please review our Terms and Privacy Policy</h2>
        <p id="termsText">To keep using your Veridium account, please read and accept our Terms of Service and Privacy Policy.
          They explain what we collect, who can see it, and how you can delete your account.</p>
        <div class="links"><a href="terms.html" target="_blank" rel="noopener">Terms of Service ↗</a><a href="privacy.html" target="_blank" rel="noopener">Privacy Policy ↗</a></div>
        <div class="actions"><button class="btn primary" type="button" data-accept>I accept</button><button class="btn" type="button" data-logout>Log out</button></div>
        <div class="form-msg error" role="alert"></div>
      </div>`;
    document.body.append(gate);
    document.body.style.overflow = 'hidden';
    const accept = gate.querySelector('[data-accept]');
    accept.focus();
    // Keep keyboard focus inside the dialog.
    gate.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const items = [...gate.querySelectorAll('a, button')];
      const i = items.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
      e.preventDefault();
      items[next].focus();
    });
    gate.querySelector('[data-logout]').addEventListener('click', logout);
    accept.addEventListener('click', async () => {
      accept.disabled = true;
      try {
        const { termsVersion } = await (await fetch('/api/legal')).json();
        const res = await fetch('/api/auth/accept-terms', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: termsVersion }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Something went wrong');
        cacheAccount(data.user);
        location.reload(); // reload so anything the page couldn't load before acceptance loads now
      } catch (err) {
        gate.querySelector('.form-msg').textContent = err.message;
        accept.disabled = false;
      }
    });
  }

  // Footer with the legal links on every page (the landing page has its own).
  function footer() {
    if (document.body.dataset.page === 'landing' || document.querySelector('.site-footer')) return;
    const el = document.createElement('footer');
    el.className = 'site-footer';
    el.innerHTML = `<span>© ${new Date().getFullYear()} Veridium · Not endorsed by Riot Games.</span>
      <nav aria-label="Legal"><a href="privacy.html">Privacy Policy</a><a href="terms.html">Terms of Service</a></nav>`;
    document.body.append(el);
  }

  /** Call after logging in, signing up or linking a Riot ID: caches the account the server returned. */
  function signedIn(user) {
    cacheAccount(user);
    render();
  }

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    cacheAccount(null);
    location.href = 'welcome.html';
  }

  /** The login page (or sign-up, with optional prefill), returning here afterwards. */
  function loginHref(mode = 'login', params = {}) {
    const q = new URLSearchParams({ ...(mode === 'signup' && { mode }), ...params, next: location.pathname + location.search + location.hash });
    return `login.html?${q}`;
  }

  const playerHref = (riotId, region) =>
    `player.html?riotId=${encodeURIComponent(riotId)}&region=${encodeURIComponent(region)}`;

  function accountMenu(account) {
    const me = getMe();
    const label = me ? me.riotId : account.email;
    const orgs = account.adminOf || [];
    return `<div class="me-wrap">
      <button class="me-chip" id="meBtn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="meMenu" title="Account: ${escape(label)}">
        <span class="mini-avatar">${escape(label.charAt(0).toUpperCase())}</span></button>
      <div class="me-menu" id="meMenu" role="menu" hidden>
        <div class="me-head"><b>${escape(me ? me.riotId.split('#')[0] : 'Your account')}</b><span>${escape(account.email)}</span></div>
        ${me ? `<a role="menuitem" href="${playerHref(me.riotId, me.region)}">My profile</a>`
          : '<a role="menuitem" href="login.html#link">Link your Riot ID</a>'}
        ${orgs.map((o) => `<a role="menuitem" href="org.html?id=${encodeURIComponent(o.id)}">${escape(o.name)} <small>Admin</small></a>`).join('')}
        <a role="menuitem" href="login.html">Account settings</a>
        <button role="menuitem" type="button" id="logoutBtn">Log out</button>
      </div>
    </div>`;
  }

  let closeMenu = () => {};
  function render() {
    const el = document.getElementById('site-header');
    if (!el) return;
    const page = document.body.dataset.page;
    const account = getAccount();
    const q = new URLSearchParams(location.search).get('q') ?? '';
    el.className = 'site-header';
    el.innerHTML = `
      <a class="logo" href="/" aria-label="Veridium home">
        <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 5h8l5 13 5-13h8L19 28h-6z" fill="#4f46e5"/><path d="M11 5l5 13 5-13h-3l-2 6-2-6z" fill="#8b83ff"/></svg>
        VERIDIUM
      </a>
      <form class="site-search" role="search" id="siteSearch">
        ${icon('search')}
        <input name="q" value="${escape(page === 'players' ? q : '')}" placeholder="Search players, organizations, games…" title="Tip: type a full Riot ID like Name#TAG to open that profile" aria-label="Search" />
      </form>
      <nav class="site-nav" aria-label="Main">
        ${NAV.map(([key, label, href]) => `<a href="${href}" title="${label}" class="${key === page ? 'active' : ''}" ${key === page ? 'aria-current="page"' : ''}>${icon(key)}<span>${label}</span></a>`).join('')}
      </nav>
      ${account
        ? accountMenu(account)
        : page === 'login'
          ? ''
          : `<div class="header-ctas"><a class="btn" href="${escape(loginHref())}">Log in</a><a class="btn primary" href="${escape(loginHref('signup'))}">Sign up</a></div>`}`;
    document.getElementById('siteSearch').addEventListener('submit', (e) => {
      e.preventDefault();
      const term = e.target.q.value.trim();
      if (!term) return;
      location.href = term.includes('#') ? playerHref(term, getMe()?.region ?? 'na1') : `players.html?q=${encodeURIComponent(term)}`;
    });
    const btn = document.getElementById('meBtn');
    if (btn) {
      const menu = document.getElementById('meMenu');
      closeMenu = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
        btn.setAttribute('aria-expanded', String(!menu.hidden));
        if (!menu.hidden) menu.querySelector('a, button')?.focus();
      });
      document.getElementById('logoutBtn').addEventListener('click', logout);
    }
  }
  // Registered once: clicking elsewhere or Escape closes the account menu.
  document.addEventListener('click', (e) => { if (!e.target.closest?.('.me-wrap')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // `ready` resolves to the server's view of the account; pages that gate on login await it.
  window.Veridium = { getAccount, getMe, refreshAccount, signedIn, logout, loginHref, playerHref };
  window.Veridium.ready = refreshAccount();
  const start = () => { render(); footer(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
