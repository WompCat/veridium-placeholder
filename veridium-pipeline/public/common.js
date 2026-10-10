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

const GAME_LABELS = { tft: 'TFT', lol: 'LoL' };

/** A player summary's best rank across games, e.g. "LoL · Diamond II". */
function fmtBestRank(p) {
  return p.bestRank ? `${GAME_LABELS[p.bestRank.game]} · ${fmtRank(p.bestRank)}` : 'Unranked';
}

/** Games a player summary has data for, e.g. "TFT · LoL". */
function playedGames(p) {
  return [p.totalMatches || p.rank ? 'TFT' : null, p.lol?.games || p.lol?.soloRank ? 'LoL' : null].filter(Boolean).join(' · ') || 'TFT';
}

function profileUrl(player) {
  return `player.html?riotId=${encodeURIComponent(player.riotId)}&region=${encodeURIComponent(player.region)}`;
}

/** "3h ago", "2d ago", or a date for anything older than a week. */
function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  if (mins < 10080) return `${Math.round(mins / 1440)}d ago`;
  return fmtDate(iso);
}

const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

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

/**
 * The step between "Apply" and sending: an optional, self-reported "I am under 18". Only the
 * organization the application goes to sees it (see privacy.html#under-18).
 */
function applyConfirmForm(vacancyId) {
  return `<form class="apply-confirm" data-confirm="${esc(vacancyId)}">
    <label class="u18"><input type="checkbox" name="under18" />
      <span><b>I am under 18</b> <span class="sub">(optional)</span><br>
        <span class="sub">Only this organization sees this, so it knows a parent's or guardian's consent is needed before any offer.
          <a href="privacy.html#under-18" target="_blank" rel="noopener">How it's used</a></span></span></label>
    <div class="apply-confirm-actions"><button class="btn primary small">Send application</button>
      <button class="btn small" type="button" data-cancel>Cancel</button></div>
  </form>`;
}

function submitApplication(vacancyId, under18) {
  return api(`/api/vacancies/${encodeURIComponent(vacancyId)}/applications`, { method: 'POST', body: { under18 } });
}
