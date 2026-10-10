import type { LolLeagueEntryDto, LolMatchDto } from '../lol/types';
import type { RiotAccountDto, TftLeagueEntryDto, TftMatchDto } from '../types';
import { hostFor, type RegionalRoute } from './regions';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RateWindow {
  limit: number;
  windowMs: number;
}

// Riot development key limits.
export const DEV_KEY_LIMITS: RateWindow[] = [
  { limit: 20, windowMs: 1_000 },
  { limit: 100, windowMs: 120_000 },
];

/**
 * Token bucket per rate window: each window starts full and a token is handed back
 * `windowMs` after it was spent. That keeps us under Riot's limits even when their
 * window boundaries don't line up with ours. A request waits until every window has a token.
 */
export class RateLimiter {
  private spent: number[][];

  constructor(
    private windows: RateWindow[] = DEV_KEY_LIMITS,
    private now: () => number = Date.now,
    private sleep: SleepFn = defaultSleep,
  ) {
    this.spent = windows.map(() => []);
  }

  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      let wait = 0;
      this.windows.forEach((w, i) => {
        const spent = this.spent[i];
        while (spent.length && spent[0] <= t - w.windowMs) spent.shift();
        if (spent.length >= w.limit) wait = Math.max(wait, spent[0] + w.windowMs - t);
      });
      if (wait <= 0) {
        this.spent.forEach((spent) => spent.push(t));
        return;
      }
      await this.sleep(wait);
    }
  }
}

export class RiotApiError extends Error {
  constructor(
    public status: number,
    public url: string,
    body: string,
  ) {
    super(`Riot API ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

export interface RiotClientOptions {
  apiKey: string;
  fetch?: FetchFn;
  limiter?: RateLimiter;
  sleep?: SleepFn;
  maxRetries?: number;
}

export class RiotClient {
  private fetchFn: FetchFn;
  private limiter: RateLimiter;
  private sleep: SleepFn;
  private maxRetries: number;

  constructor(private opts: RiotClientOptions) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.limiter = opts.limiter ?? new RateLimiter(DEV_KEY_LIMITS, Date.now, this.sleep);
    this.maxRetries = opts.maxRetries ?? 3;
  }

  /** GET a Riot endpoint. Retries 429 (honouring Retry-After) and 5xx with backoff. */
  async get<T>(route: string, path: string): Promise<T> {
    if (!this.opts.apiKey) throw new Error('RIOT_API_KEY is not set');
    const url = hostFor(route) + path;

    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      const res = await this.fetchFn(url, { headers: { 'X-Riot-Token': this.opts.apiKey } });
      if (res.ok) return (await res.json()) as T;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        throw new RiotApiError(res.status, url, await res.text().catch(() => ''));
      }
      const retryAfter = Number(res.headers.get('Retry-After'));
      const delayMs = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      await this.sleep(delayMs);
    }
  }

  getAccountByRiotId(regional: RegionalRoute, gameName: string, tagLine: string) {
    return this.get<RiotAccountDto>(
      regional,
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    );
  }

  /** Match ids, most recent first. Page through history with `start` (Riot allows `count` up to 200). */
  getMatchIds(regional: RegionalRoute, puuid: string, opts: { start: number; count: number }) {
    const params = new URLSearchParams({ start: String(opts.start), count: String(opts.count) });
    return this.get<string[]>(regional, `/tft/match/v1/matches/by-puuid/${puuid}/ids?${params}`);
  }

  getMatch(regional: RegionalRoute, matchId: string) {
    return this.get<TftMatchDto>(regional, `/tft/match/v1/matches/${matchId}`);
  }

  getLeagueEntries(platform: string, puuid: string) {
    return this.get<TftLeagueEntryDto[]>(platform, `/tft/league/v1/by-puuid/${puuid}`);
  }

  // ---- League of Legends ----

  /** Ranked match ids (Solo/Duo + Flex), most recent first. Riot allows `count` up to 100. */
  getLolMatchIds(regional: RegionalRoute, puuid: string, opts: { start: number; count: number }) {
    const params = new URLSearchParams({ type: 'ranked', start: String(opts.start), count: String(opts.count) });
    return this.get<string[]>(regional, `/lol/match/v5/matches/by-puuid/${puuid}/ids?${params}`);
  }

  getLolMatch(regional: RegionalRoute, matchId: string) {
    return this.get<LolMatchDto>(regional, `/lol/match/v5/matches/${matchId}`);
  }

  getLolLeagueEntries(platform: string, puuid: string) {
    return this.get<LolLeagueEntryDto[]>(platform, `/lol/league/v4/entries/by-puuid/${puuid}`);
  }
}
