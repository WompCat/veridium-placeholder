// Usage: npm run ingest -- "WompCat#NA1" [na1]
import { Store } from './cache/store';
import { config } from './config';
import { RiotClient } from './riot/client';
import { ingestPlayer, loadProfile } from './tft/ingest';

const [riotId, region = 'na1'] = process.argv.slice(2);
if (!riotId) {
  console.error('Usage: npm run ingest -- "Name#TAG" [region]');
  process.exit(1);
}
if (!config.riotApiKey) {
  console.error('RIOT_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const store = new Store(config.dbPath);
const deps = { client: new RiotClient({ apiKey: config.riotApiKey }), store, seasons: config.seasons };
const started = Date.now();
try {
  const result = await ingestPlayer(deps, region, riotId);
  console.log(`Fetched ${result.fetchedMatchIds.length} new match(es).`);
  if (!result.profile.history.complete) {
    console.log(`Loading ${config.seasons} seasons of history (dev keys allow ~50 matches/minute)...`);
    const timer = setInterval(() => {
      const p = loadProfile(deps, result.puuid, result.profile.riotId, region);
      console.log(`  ${p.seasons.reduce((n, s) => n + s.totalMatches, 0)} matches cached`);
    }, 15_000);
    await result.history.finally(() => clearInterval(timer));
  }

  const p = loadProfile(deps, result.puuid, result.profile.riotId, region);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const rank = p.rank ? `${p.rank.tier} ${p.rank.division} ${p.rank.leaguePoints} LP` : 'Unranked';
  console.log(`\n${p.riotId} (${p.region}) · ${rank} · history ${p.history.complete ? 'complete' : 'incomplete'}`);
  for (const s of p.seasons) {
    console.log(
      `  ${s.label}${s.current ? ' (current)' : ''}: ${s.totalMatches} matches (${s.rankedMatches} ranked), ` +
        `top-4 ${pct(s.winRate)}, avg place ${s.avgPlacement}, 1st ${pct(s.top1Rate)}`,
    );
  }
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  store.close();
}
