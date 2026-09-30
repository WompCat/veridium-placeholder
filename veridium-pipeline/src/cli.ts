// Usage: npm run ingest -- "WompCat#NA1" [na1]
import { Store } from './cache/store';
import { config } from './config';
import { RiotClient } from './riot/client';
import { ingestPlayer } from './tft/ingest';

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
const started = Date.now();
try {
  const result = await ingestPlayer(
    { client: new RiotClient({ apiKey: config.riotApiKey }), store, matchWindow: config.matchWindow },
    region,
    riotId,
  );
  console.log(JSON.stringify(result.profile, null, 2));
  console.log(
    `\npuuid ${result.puuid}\nfetched ${result.fetchedMatchIds.length} new match(es), ` +
      `${result.cachedMatchIds.length} already cached, in ${Date.now() - started}ms`,
  );
} finally {
  store.close();
}
