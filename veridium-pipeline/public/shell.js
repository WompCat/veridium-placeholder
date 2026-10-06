// Shared site header for every page: logo, search, icon nav, and "me".
// A page sets <body data-page="home|players|organizations|tournaments|jobs"> and has <header id="site-header">.
// "Me" is the Riot ID this browser has identified as (no accounts yet), stored locally only.
(() => {
  const ME_KEY = 'veridium.lastRiotId';
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

  function getMe() {
    try {
      const me = JSON.parse(localStorage.getItem(ME_KEY));
      return me && me.riotId && me.region ? me : null;
    } catch {
      return null;
    }
  }
  function setMe(riotId, region) {
    try { localStorage.setItem(ME_KEY, JSON.stringify({ riotId, region })); } catch {}
    render();
  }
  function clearMe() {
    try { localStorage.removeItem(ME_KEY); } catch {}
    render();
  }
  const playerHref = (riotId, region) =>
    `player.html?riotId=${encodeURIComponent(riotId)}&region=${encodeURIComponent(region)}`;

  function render() {
    const el = document.getElementById('site-header');
    if (!el) return;
    const page = document.body.dataset.page;
    const me = getMe();
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
        ${NAV.map(([key, label, href]) => `<a href="${href}" class="${key === page ? 'active' : ''}" ${key === page ? 'aria-current="page"' : ''}>${icon(key)}<span>${label}</span></a>`).join('')}
      </nav>
      ${me
        ? `<a class="me-chip" href="${playerHref(me.riotId, me.region)}" title="My profile: ${escape(me.riotId)}"><span class="mini-avatar">${escape(me.riotId.charAt(0).toUpperCase())}</span></a>`
        : `<a class="me-chip setup" href="/#me">Set up profile</a>`}`;
    document.getElementById('siteSearch').addEventListener('submit', (e) => {
      e.preventDefault();
      const term = e.target.q.value.trim();
      if (!term) return;
      location.href = term.includes('#') ? playerHref(term, getMe()?.region ?? 'na1') : `players.html?q=${encodeURIComponent(term)}`;
    });
  }

  window.Veridium = { getMe, setMe, clearMe, playerHref };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
