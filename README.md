# Veridium

Verified esports player profiles. `veridium-pipeline/` holds:

- **TFT / Riot API ingestion pipeline** (rebuild step 1) and the Player Profile page (`/`)
- **Organization & vacancy backend** (rebuild steps 3–4): rosters, vacancy postings and applications,
  with the Org Dashboard (`/org.html?id=obscurity-esports`) and Jobs page (`/jobs.html`)

## Quick start (Windows / PowerShell)

```powershell
git clone https://github.com/WompCat/veridium-placeholder.git "C:\Users\Anthony\Projects\Veridium Placeholder"
cd "C:\Users\Anthony\Projects\Veridium Placeholder\veridium-pipeline"
git checkout claude/build-order-review-rbzbu7
npm install
copy .env.example .env      # then paste your RIOT_API_KEY into .env
npm run seed                # creates the Obscurity Esports org record (safe to re-run)
npm test                    # mocked Riot responses, no key needed
npm run ingest -- "WompCat#NA1" na1   # one live ingestion run, prints the profile JSON
npm run dev                 # http://localhost:4000/?riotId=WompCat%23NA1&region=na1
                            # http://localhost:4000/org.html?id=obscurity-esports
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
| `migrations/` | numbered `.sql` files applied in order on startup (see below) |

### Notes on the numbers

- **Win rate** is the top-4 rate, which is how Riot counts a TFT "win". `top1Rate` is returned alongside it.
- **Totals and averages** are per season (all queues). Past seasons have no rank, because Riot only reports the current one.
- **LP change and rank after** don't exist in Riot's API. They're derived from rank snapshots: a match's
  LP change is shown only when two snapshots are exactly one ranked game apart around that match.
  Otherwise the value is `null` and the UI shows "—". These fill in as the profile is loaded more often.
- **Highest rank** is the highest snapshot Veridium has recorded, not the player's all-time peak.
- **Percentile** is `null` because Riot doesn't provide one.

## Organizations & vacancies

Rosters, vacancies and applications live in the same sqlite file as the pipeline. They only ever
store a `playerPuuid`. Verified stats are read from the pipeline's tables when a response is built,
so an application's "resume" is always the player's live profile.

The **player ↔ org loop**: an org posts a vacancy, and a player applies from the Jobs page or with
one click from their profile. There are no stat fields to fill in, because the org sees their
verified profile. The org reviews applicants in a table with the same Rank / Win Rate columns as
the roster, then accepts or rejects. "Accept & add to roster" updates the application and adds the
roster row in one transaction, so they can't disagree. "Accept only" leaves an **Add to roster**
button, pre-filled with the vacancy's role, for later. Players see each application's status on
their profile.

| Endpoint | |
| --- | --- |
| `GET /api/organizations/:id` | org name and roster size |
| `GET /api/organizations/:id/roster` | active then bench members, each with `player` stats |
| `POST /api/organizations/:id/roster` | `{ playerPuuid \| riotId+region, role, status? }` |
| `PATCH /api/organizations/:id/roster/:playerPuuid` | `{ role?, status? }` (`active` / `bench`) |
| `DELETE /api/organizations/:id/roster/:playerPuuid` | sets `leftAt`; the row stays as roster history |
| `GET /api/organizations/:id/vacancies` | the org's postings, with application counts |
| `POST /api/organizations/:id/vacancies` | `{ title, role?, game? = TFT, region? = NA, level? = competitive }` |
| `PATCH /api/vacancies/:id` | `{ status: open \| closed }` (title/role/game/region/level also editable) |
| `GET /api/vacancies?game=&region=&role=&status=` | public listing, newest first; `status` defaults to `open`, or `closed` / `all` |
| `POST /api/vacancies/:id/applications` | `{ playerPuuid \| riotId+region }` |
| `GET /api/vacancies/:id/applications` | pending first, each with `player` stats and `onRoster` |
| `PATCH /api/applications/:id` | `{ status: accepted \| rejected, addToRoster? = true, role?, rosterStatus? }` |
| `POST /api/applications/:id/roster` | add an accepted applicant: `{ role? = vacancy role or title, status? = active }` |
| `GET /api/players/:region/:riotId/applications` | a player's own applications with vacancy, org and status |

Players must already be cached by the pipeline (their profile loaded once) before they can be
rostered or apply. Otherwise the API returns 404. The Org Dashboard and Jobs pages load the
profile first automatically. If Riot can't be reached (for example, an expired dev key), the pages
fall back to the cached profile, so players who are already cached still work.

Applications are stored by PUUID, Riot's permanent account ID, but the API accepts a Riot ID +
region. Riot IDs can be renamed, while a PUUID never changes, so a renamed player keeps their
application history. Errors use `400` (bad input), `404` (missing org/player/vacancy) and
`409` (already on the roster, already applied, vacancy closed, application already decided).

### Migrations

`migrations/NNN_name.sql` files run in order the first time the store opens a database (server,
CLI, seed or tests), and each is recorded in `schema_migrations`. `001_pipeline.sql` is the
pipeline schema with `IF NOT EXISTS`, so databases from before migrations existed adopt it
unchanged. To change the schema, add the next numbered file. Never edit one that has already shipped.

### Open decisions

- **Who can post vacancies / manage the roster.** There are no accounts yet, so every org endpoint
  is open to anyone who can reach the server. Add auth before this is exposed beyond local use.
- **Free vs paid vacancy postings.** There's no `plan` / `billingStatus` on `Organization` yet. Add
  it in a new migration once that's decided.
- **Obscurity Esports** is created by `npm run seed`, not by a migration, so it's easy to change or drop.

## Deploying (Render)

The app is one Node process plus a sqlite file, so it needs a host with a **persistent disk**.
Serverless hosts (Vercel, Netlify functions) won't work, because the database would vanish
between requests. The repo is set up for [Render](https://render.com):

- `veridium-pipeline/Dockerfile` builds the app. On every boot it applies new migrations, runs
  the idempotent seed, and starts the server.
- `render.yaml` (a Render Blueprint) declares the web service, a 1 GB disk mounted at
  `/var/data`, `DB_PATH=/var/data/veridium.db` on that disk, and the env vars to fill in.
  Disks need a paid instance type, so the Blueprint uses `starter`. Check Render's current pricing.

**First deploy**

1. Get this work onto `main`, since the Blueprint deploys `main`. The repo has no `main` yet, so create
   it from this branch on GitHub (or merge into it once it exists).
2. In Render: **New → Blueprint**, connect the `veridium-placeholder` GitHub repo, and apply.
3. When prompted, set **`RIOT_API_KEY`** (the bare `RGAPI-…` key) and **`SITE_PASSWORD`**.
4. Render builds the image and gives you an `https://veridium-….onrender.com` URL. Visit
   `/api/health` (open without the password), then `/org.html?id=obscurity-esports`.

**Production settings**

| Variable | |
| --- | --- |
| `RIOT_API_KEY` | set in Render's dashboard; never committed (`.env` is gitignored) |
| `DB_PATH` | `/var/data/veridium.db`, which must sit on the disk mount or data is lost on redeploy |
| `SEASONS` | `3` |
| `SITE_PASSWORD` | puts the whole site behind a browser password prompt. There are no accounts yet, so without it anyone with the URL can edit rosters and use up the Riot key's rate limit |
| `PORT` | injected by Render; the app reads `process.env.PORT` (4000 is only the local default) |
| `HOST` | `0.0.0.0` by default, so Render can route traffic in |

**Daily key rotation.** A Riot development key expires every 24 hours, on the deployed site too.
Update `RIOT_API_KEY` in Render each day (Render restarts the service with the new value), or
profile lookups fail for every visitor. Cached profiles still display, with a notice. A Riot
production key is the only permanent fix, and the deployed prototype is good evidence for that
application.
