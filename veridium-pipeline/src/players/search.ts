import { badRequest } from '../orgs/errors';
import { isPlatform } from '../riot/regions';
import { ladderScore, TIERS } from '../tft/aggregate';
import type { PlayerSummary, RankEntry } from '../types';

export const LOL_ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;

/** Player search, for orgs scouting beyond their applicants. Every filter is optional. */
export interface PlayerFilters {
  game?: 'tft' | 'lol';   // has data for this game; rank filters and sorting then use this game's rank
  region?: string;        // platform, e.g. na1
  minTier?: string;       // e.g. DIAMOND: that tier or higher
  role?: (typeof LOL_ROLES)[number]; // League of Legends role played most this season
  lft?: boolean;          // only players who opted into "Looking for team"
  q?: string;             // part of the Riot ID
}

type Query = Record<string, unknown>;
const str = (q: Query, key: string) => (typeof q[key] === 'string' && q[key] ? String(q[key]).trim() : undefined);

export function parsePlayerFilters(query: Query): PlayerFilters {
  const f: PlayerFilters = {};
  const game = str(query, 'game')?.toLowerCase();
  if (game) {
    if (game !== 'tft' && game !== 'lol') throw badRequest('"game" must be tft or lol');
    f.game = game;
  }
  const region = str(query, 'region')?.toLowerCase();
  if (region) {
    if (!isPlatform(region)) throw badRequest(`Unknown region "${region}"`);
    f.region = region;
  }
  const minTier = str(query, 'minTier')?.toUpperCase();
  if (minTier) {
    if (!TIERS.includes(minTier)) throw badRequest(`"minTier" must be one of: ${TIERS.join(', ')}`);
    f.minTier = minTier;
  }
  const role = str(query, 'role')?.toUpperCase();
  if (role) {
    if (!(LOL_ROLES as readonly string[]).includes(role)) throw badRequest(`"role" must be one of: ${LOL_ROLES.join(', ')}`);
    f.role = role as PlayerFilters['role'];
  }
  if (str(query, 'lft') === '1' || str(query, 'lft') === 'true') f.lft = true;
  const q = str(query, 'q');
  if (q) f.q = q.slice(0, 40).toLowerCase();
  return f;
}

const hasTft = (p: PlayerSummary) => p.totalMatches > 0 || !!p.rank;
const hasLol = (p: PlayerSummary) => !!p.lol && (p.lol.games > 0 || !!p.lol.soloRank);

/** The rank a search compares and sorts by: the chosen game's, else the player's best. */
function rankFor(p: PlayerSummary, game: PlayerFilters['game']): RankEntry | null {
  if (game === 'tft') return p.rank;
  if (game === 'lol') return p.lol?.soloRank ?? null;
  return p.bestRank;
}

export function searchPlayers(players: PlayerSummary[], f: PlayerFilters): PlayerSummary[] {
  const game = f.game ?? (f.role ? 'lol' : undefined); // a LoL role implies LoL
  const min = f.minTier ? TIERS.indexOf(f.minTier) : -1;
  return players
    .filter((p) => {
      if (game === 'tft' && !hasTft(p)) return false;
      if (game === 'lol' && !hasLol(p)) return false;
      if (f.region && p.region !== f.region) return false;
      if (f.role && p.lol?.mainRole !== f.role) return false;
      if (f.lft && !p.lookingForTeam) return false;
      if (f.q && !p.riotId.toLowerCase().includes(f.q)) return false;
      if (min >= 0) {
        const r = rankFor(p, game);
        if (!r || TIERS.indexOf(r.tier) < min) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const ra = rankFor(a, game), rb = rankFor(b, game);
      if (ra && rb) return ladderScore(rb) - ladderScore(ra) || a.riotId.localeCompare(b.riotId);
      if (ra || rb) return ra ? -1 : 1;
      return a.riotId.localeCompare(b.riotId);
    });
}
