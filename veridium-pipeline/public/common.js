// Shared helpers for the Org Dashboard and Jobs pages.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
const pct = (n) => (n * 100).toFixed(1) + '%';
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function fmtRank(rank) {
  if (!rank) return 'Unranked';
  const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(rank.tier);
  return apex ? titleCase(rank.tier) : `${titleCase(rank.tier)} ${rank.division}`;
}

function profileUrl(player) {
  return `/?riotId=${encodeURIComponent(player.riotId)}&region=${encodeURIComponent(player.region)}`;
}

/** fetch + JSON, throwing the API's error message on failure. */
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/**
 * Make sure the pipeline has this player's verified profile cached (fetching from Riot if needed),
 * so org and application endpoints can reference them. If Riot can't be reached (e.g. an expired
 * dev key), a player who's already cached still works.
 */
async function loadPlayer(riotId, region) {
  const path = `/api/players/${encodeURIComponent(region)}/${encodeURIComponent(riotId)}/profile`;
  try {
    return await api(path);
  } catch (err) {
    try {
      return await api(`${path}?cached=1`);
    } catch {
      throw err;
    }
  }
}

function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'form-msg' + (kind ? ' ' + kind : '');
}

const REGIONS = ['na1', 'euw1', 'eun1', 'kr', 'br1', 'la1', 'la2', 'oc1', 'jp1', 'tr1'];
const regionOptions = (selected) => REGIONS.map((r) => `<option${r === selected ? ' selected' : ''}>${r}</option>`).join('');
