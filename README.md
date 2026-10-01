# Veridium

Verified esports player profiles. This repo currently holds step 1 of the rebuild plan, the
**TFT / Riot API ingestion pipeline** (`veridium-pipeline/`), plus a Player Profile page that reads from it.

## Quick start (Windows / PowerShell)

```powershell
git clone https://github.com/WompCat/veridium-placeholder.git "C:\Users\Anthony\Projects\Veridium Placeholder"
cd "C:\Users\Anthony\Projects\Veridium Placeholder\veridium-pipeline"
git checkout claude/build-order-review-rbzbu7
npm install
copy .env.example .env      # then paste your RIOT_API_KEY into .env
npm test                    # mocked Riot responses, no key needed
npm run ingest -- "WompCat#NA1" na1   # one live ingestion run, prints the profile JSON
npm run dev                 # http://localhost:4000/?riotId=WompCat%23NA1&region=na1
```

Riot development keys expire every 24 hours, so regenerate yours at
<https://developer.riotgames.com> and update `.env` when requests start returning 401/403.

### In a Claude Code cloud session

The environment's network proxy injects the Riot key, so no real key lives in the container. Node's
`fetch` only goes through that proxy when told to:

```bash
NODE_USE_ENV_PROXY=1 RIOT_API_KEY=proxy-injected npm run ingest -- "WompCat#NA1" na1
```

## Pipeline

```
GET /api/players/:region/:riotId/profile      e.g. /api/players/na1/WompCat%23NA1/profile
```

`riotId` is `Name#TAG` URL-encoded (`Name%23TAG`), or `Name-TAG`.

Each request runs one ingestion for that player:

1. `account-v1` resolves the Riot ID to a PUUID (regional host, e.g. `americas`).
2. `tft-match-v1` pages through the player's match ids, newest first, until it reaches games
   already synced. A player who has never been loaded gets one page (20 games) right away.
3. Each match id is checked against the sqlite cache, and only uncached matches are fetched. All 8
   lobby participants are stored, so lobby-mates' later loads are cheaper too.
4. `tft-league-v1` fetches the rank entry on every run (platform host, e.g. `na1`), in parallel with
   step 2. Each run stores it as a snapshot.
5. The results are aggregated into the profile response, grouped by season.

### Seasons

Each TFT set is a ranked season, and every match records its set number. The pipeline keeps the
full history of the current set plus the previous `SEASONS - 1` (default 3: e.g. Sets 18, 17, 16).
The current set is the newest set seen in any cached match.

The first time a player is loaded, the rest of those seasons is fetched in the background
(`history.syncing: true` in the response). A dev key allows about 50 matches a minute, so a few
hundred games take several minutes. The profile page shows progress and re-reads
`GET /api/players/:region/:riotId/profile?cached=1` (cache only, no Riot calls) until it's done.
After that, loads only fetch new games. The backfill stops once it has seen 10 games in a row from
before the oldest tracked set, so a stray revival-event game from an old set doesn't end it early.

The response's top-level stats and `recentMatches` describe the current season. `seasons` lists
each tracked season, newest first, with its own stats and every match.

| File | Role |
| --- | --- |
| `src/config.ts` | `.env` loading (`RIOT_API_KEY`, `PORT`, `DB_PATH`, `SEASONS`) |
| `src/riot/client.ts` | fetch wrapper: `X-Riot-Token`, rate limiter (20/1s + 100/2min), retry on 429 via `Retry-After` and on 5xx with backoff |
| `src/riot/regions.ts` | platform → regional routing (`na1 → americas`, …) |
| `src/cache/store.ts` | sqlite schema + helpers: players, matches (raw JSON), matchups, rank snapshots |
| `src/tft/ingest.ts` | orchestrates one player's ingestion run and the season backfill |
| `src/tft/transform.ts` | raw Riot JSON → `Matchup` / rank snapshot |
| `src/tft/aggregate.ts` | `Matchup[]` + snapshots → profile stats |
| `src/routes/players.ts`, `src/server.ts` | Express endpoint + static Player Profile page (`public/index.html`) |
| `src/cli.ts` | `npm run ingest -- "Name#TAG" [region]` |

### Notes on the numbers

- **Win rate** is the top-4 rate, which is how Riot counts a TFT "win". `top1Rate` is returned alongside it.
- **Totals and averages** are per season (all queues). Past seasons have no rank, because Riot only reports the current one.
- **LP change and rank after** don't exist in Riot's API. They're derived from rank snapshots: a match's
  LP change is shown only when two snapshots are exactly one ranked game apart around that match.
  Otherwise the value is `null` and the UI shows "—". These fill in as the profile is loaded more often.
- **Highest rank** is the highest snapshot Veridium has recorded, not the player's all-time peak.
- **Percentile** is `null` because Riot doesn't provide one.
