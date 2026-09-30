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

## Pipeline

```
GET /api/players/:region/:riotId/profile      e.g. /api/players/na1/WompCat%23NA1/profile
```

`riotId` is `Name#TAG` URL-encoded (`Name%23TAG`), or `Name-TAG`.

Each request runs one ingestion for that player:

1. `account-v1` resolves the Riot ID to a PUUID (regional host, e.g. `americas`).
2. `tft-match-v1` returns the last `MATCH_WINDOW` match ids. After the first run it only asks for
   ids newer than the player's last sync point.
3. Each match id is checked against the sqlite cache, and only uncached matches are fetched. All 8
   lobby participants are stored, so lobby-mates' later loads are cheaper too.
4. `tft-league-v1` fetches the rank entry on every run (platform host, e.g. `na1`), in parallel with
   step 2. Each run stores it as a snapshot.
5. The results are aggregated into the profile response.

| File | Role |
| --- | --- |
| `src/config.ts` | `.env` loading (`RIOT_API_KEY`, `PORT`, `DB_PATH`, `MATCH_WINDOW`) |
| `src/riot/client.ts` | fetch wrapper: `X-Riot-Token`, rate limiter (20/1s + 100/2min), retry on 429 via `Retry-After` and on 5xx with backoff |
| `src/riot/regions.ts` | platform → regional routing (`na1 → americas`, …) |
| `src/cache/store.ts` | sqlite schema + helpers: players, matches (raw JSON), matchups, rank snapshots |
| `src/tft/ingest.ts` | orchestrates one player's ingestion run |
| `src/tft/transform.ts` | raw Riot JSON → `Matchup` / rank snapshot |
| `src/tft/aggregate.ts` | `Matchup[]` + snapshots → profile stats |
| `src/routes/players.ts`, `src/server.ts` | Express endpoint + static Player Profile page (`public/index.html`) |
| `src/cli.ts` | `npm run ingest -- "Name#TAG" [region]` |

### Notes on the numbers

- **Win rate** is the top-4 rate, which is how Riot counts a TFT "win". `top1Rate` is returned alongside it.
- **Totals and averages** cover the match window (last `MATCH_WINDOW` games, default 20), not the player's full career.
- **LP change and rank after** don't exist in Riot's API. They're derived from rank snapshots: a match's
  LP change is shown only when two snapshots are exactly one ranked game apart around that match.
  Otherwise the value is `null` and the UI shows "—". These fill in as the profile is loaded more often.
- **Highest rank** is the highest snapshot Veridium has recorded, not the player's all-time peak.
- **Percentile** is `null` because Riot doesn't provide one.
