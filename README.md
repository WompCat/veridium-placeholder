# Veridium

Verified esports player profiles. `veridium-pipeline/` holds:

- **TFT / Riot API ingestion pipeline** (rebuild step 1) and the Player Profile page (`/`)
- **Organization & vacancy backend** (rebuild steps 3–4): rosters, vacancy postings and applications,
  with the Organizations directory (`/organizations.html`), Org Dashboard and Jobs page (`/jobs.html`)
- **Accounts** with a Privacy Policy (`/privacy.html`) and Terms of Service (`/terms.html`) to accept

## Quick start (Windows / PowerShell)

```powershell
git clone https://github.com/WompCat/veridium-placeholder.git "C:\Users\Anthony\Projects\Veridium Placeholder"
cd "C:\Users\Anthony\Projects\Veridium Placeholder\veridium-pipeline"
npm install
copy .env.example .env      # then paste your RIOT_API_KEY into .env
npm test                    # mocked Riot responses, no key needed
npm run ingest -- "WompCat#NA1" na1   # one live ingestion run, prints the profile JSON
npm run dev                 # http://localhost:4000/  (home)
                            # http://localhost:4000/player.html?riotId=WompCat%23NA1&region=na1
                            # http://localhost:4000/organizations.html  (sign up, then create an org)
```

Riot development keys expire every 24 hours, so regenerate yours at
<https://developer.riotgames.com> and update `.env` when requests start returning 401/403.

### In GitHub Codespaces

`.devcontainer/devcontainer.json` sets up Node 22, runs `npm ci` and forwards port 4000. On the repo's
GitHub page: **Code → Codespaces → Create codespace on main**. Add your key as a Codespaces secret
named `RIOT_API_KEY` (GitHub → Settings → Codespaces), then in the Codespace terminal:
`cd veridium-pipeline && npm run dev`, and open the forwarded port 4000.

### Behind an outbound proxy

If outbound traffic goes through a proxy (for example one that adds the Riot key itself, so no real key
lives on the machine), Node's `fetch` only uses it when told to:

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
| `src/routes/players.ts`, `src/server.ts` | Express endpoints + the static pages in `public/` (see Pages below) |
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

## League of Legends

`GET /api/players/:region/:riotId/lol` (with `?cached=1` for cache-only reads) loads a player's
**ranked Solo/Duo and Flex** games for the current season. A LoL season is a calendar year, unlike
TFT, where a season is a set. The flow matches TFT:

- **First load:** returns the newest 20 games right away, then backfills the rest of the season in the
  background. Later loads only fetch new games.
- **Ranks:** come from `lol-league-v4` on every load.
- **Stats:** games, win rate, average K/D/A, KDA, CS per minute, top champions and roles, plus every
  match (champion, role, result, K/D/A, CS, length).

Only ranked queues are tracked (`type=ranked`). That's what organizations recruit on, and it keeps
the first load bounded on a dev key. Data lives in its own tables (`migrations/004_lol.sql`), and
match rows are cached once and shared across players.

On the Player Profile, the Games tab's game picker switches between TFT and LoL
(`player.html?…&game=lol#games`). Overview shows a LoL card once a player has LoL data, and Home
lists it under My Games.

**Valorant** stays "Coming soon". Riot only opens Valorant match data to approved production keys,
and players have to opt in through Riot Sign On.

## Pages

All pages share one header (`public/shell.js`): search, plus Home / Players / Organizations /
Tournaments / Jobs. Searching a full Riot ID (`Name#TAG`) opens that profile, and any other text
searches the directory.

| Page | |
| --- | --- |
| `/welcome.html` Landing | the public landing page; "Create Your Profile" takes a Riot ID. First-time visitors to `/` are sent here |
| `/` Home | your profile card, an activity feed, open vacancies, players, games (once a profile is set on this device) |
| `/players.html` | directory of verified players (+ matching orgs), and lookup by Riot ID |
| `/player.html?riotId=…&region=…` | Player Profile: Overview, Games (season tabs), Matches, Tournaments, Stats, About |
| `/organizations.html` | directory of organizations |
| `/org.html?id=…` | Org Dashboard: Overview, Roster, Scrims, Vacancies, Settings |
| `/tournaments.html` | coming-soon placeholder |
| `/jobs.html` | open vacancies; apply as your own Riot ID |
| `/login.html` | log in / sign up; when logged in, account settings (link a Riot ID, log out) |

**Accounts.** Sign up with an email and password, plus your Riot ID (optional for recruiters; it can
be linked later). The Riot ID is looked up with Riot and one Riot ID belongs to one account at most.
Sessions are a random token in an HttpOnly, SameSite=Lax cookie (30 days); the database stores only
its SHA-256, and passwords only as scrypt hashes. Failed logins are throttled per email.

| Who | Can |
|---|---|
| Anyone | browse players, profiles, orgs, rosters and open vacancies |
| A logged-in player (Riot ID linked) | apply to vacancies as themselves; see their own applications and results |
| An org admin | manage the roster, post/close vacancies, see applicants and accept/reject |

Any logged-in account can **create an organization** (Organizations page) and becomes its admin.

**Terms of Service and Privacy Policy.** `/terms.html` and `/privacy.html` describe what the code
actually does (what's collected, who sees what, the one session cookie, deletion). Sign-up needs a
"I'm at least 16 and I agree" checkbox; the accepted version and time are stored on the account.
The version lives in `src/legal.ts` (`TERMS_VERSION`): bump it, and the dates on both pages, when
either changes materially, and every account is asked to accept again before anything that needs a
login works (the API answers `403` with `code: "terms_required"`). Accounts can be deleted from
Account settings (password required): that removes the account, its sessions, its applications and
any org it's the only admin of. Set `CONTACT_EMAIL` to show a contact address on both pages.
**Recruiting and community.**
- **Player search:** the Players page filters by game, region, minimum rank, LoL main role, name and
  "Looking for team", a setting players turn on in Account settings (with optional roles).
- **Notifications:** a header bell. Org admins hear about new applicants and verification; players
  hear about decisions and roster changes. Each notification carries only what its recipient may
  already see.
- **Org profiles:** a description and website (org admins, in Settings), public roster history, and a
  "Verified" badge only Veridium staff can grant: accounts whose email is in `ADMIN_EMAILS`.
- **Follows:** follow players and orgs. Only follower counts are public. The home feed has
  "Everyone / Following" tabs.
- **Team history** on the profile's Teams tab, in two tiers: stints on a Veridium org's roster
  (verified by the org) and self-reported teams (labelled as such).
- **Tournament results**, the third tier. Anyone can apply to be a tournament organizer
  (`organizer.html`, also in the account menu). Staff approve or reject applications on `admin.html`.
  Approved organizers record finished tournaments and placements by Riot ID. Results show on the
  Tournaments page (with podiums) and on the player's Teams tab. Players are notified and can mark
  a result "Not me", which hides it from their profile and tells the organizer.
- **Email notifications:** every bell notification is also emailed through Brevo, unless the account
  turns it off in Account settings. Off for the whole site until `BREVO_API_KEY` and `EMAIL_FROM`
  are set. `SITE_URL` makes the links in emails absolute. A failed email is logged and never fails a
  request.

**Under-18 flag.** Applying shows an optional, self-reported "I am under 18" checkbox (a yes/no,
never a birthdate). It's stored on that application only (`applications.under_18`) and returned only
in the org's applicant list (`GET /api/vacancies/:id/applications`, admins), where it shows as an
"Under 18" marker and a consent reminder on Accept. It's not on profiles, searchable or filterable,
and the player's own application list doesn't return it either. Privacy Policy section "The
under-18 flag on applications" describes it.

These were written for this app, not by a lawyer, so have them reviewed before a public launch.

Not verified yet: that the person linking a Riot ID owns it. Riot only offers that through Riot Sign
On (RSO), which needs an approved production key; until then, uniqueness stops two accounts from
claiming one player, and the site password keeps a deployment private.

**Nothing on the home screen is invented.** The feed is built from real events (`GET /api/feed`):
each player's TFT and League of Legends games grouped by day, roster signings, and vacancy postings. Posting, likes,
comments, follows and esports news don't exist yet, so those parts of the mockup are either
replaced with real data (open vacancies, players on Veridium) or clearly marked "coming soon".

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
| `GET /api/organizations` | every org with roster size and open vacancies |
| `POST /api/auth/signup` | `{ email, password, riotId?, region? }`: creates the account and logs in |
| `POST /api/auth/login` · `POST /api/auth/logout` | `{ email, password }` · ends the session |
| `GET /api/auth/me` | `{ user: { email, player, adminOf } \| null }` |
| `PUT /api/auth/me/player` | `{ riotId, region }` links a Riot ID; `{ riotId: null }` unlinks |
| `GET /api/organizations/:id` | org name, roster size, and `viewer: { loggedIn, isAdmin }` |
| `POST /api/organizations` | logged in: `{ name }` creates an org and makes you its admin |
| `POST /api/auth/accept-terms` | `{ version }`: accept the current Terms and Privacy Policy |
| `DELETE /api/auth/me` | `{ password }`: delete the account (see Accounts above) |
| `GET /api/legal` | `{ termsVersion, contactEmail }` |
| `GET /api/organizations/:id/roster` | active then bench members, each with `player` stats |
| `POST /api/organizations/:id/roster` | `{ playerPuuid \| riotId+region, role, status? }` |
| `PATCH /api/organizations/:id/roster/:playerPuuid` | `{ role?, status? }` (`active` / `bench`) |
| `DELETE /api/organizations/:id/roster/:playerPuuid` | sets `leftAt`; the row stays as roster history |
| `GET /api/organizations/:id/vacancies` | the org's postings, with application counts |
| `POST /api/organizations/:id/vacancies` | `{ title, role?, game? = TFT, region? = NA, level? = competitive }` |
| `PATCH /api/vacancies/:id` | `{ status: open \| closed }` (title/role/game/region/level also editable) |
| `GET /api/vacancies?game=&region=&role=&status=` | public listing, newest first; `status` defaults to `open`, or `closed` / `all` |
| `POST /api/vacancies/:id/applications` | logged in with a linked Riot ID: applies as that player; `{ under18?: boolean }` |
| `GET /api/vacancies/:id/applications` | org admins: pending first, each with `player` stats and `onRoster` |
| `PATCH /api/applications/:id` | `{ status: accepted \| rejected, addToRoster? = true, role?, rosterStatus? }` |
| `POST /api/applications/:id/roster` | add an accepted applicant: `{ role? = vacancy role or title, status? = active }` |
| `GET /api/players/:region/:riotId/applications` | that player only: their applications with vacancy, org and status |
| `GET /api/players?game=&region=&minTier=&role=&lft=1&q=` | player search: every loaded player with verified stats, highest rank first; all filters optional |
| `PUT /api/auth/me/lft` | `{ lookingForTeam, roles? }` for your own player |
| `GET /api/notifications` · `POST /api/notifications/read` | your latest notifications and unread count · `{ ids? }` (none: all) |
| `PATCH /api/organizations/:id` | org admins: `{ description?, website? }` |
| `POST /api/organizations/:id/verify` | Veridium staff (`ADMIN_EMAILS`): `{ verified }` |
| `GET /api/organizations/:id/history` | former roster members |
| `GET` · `PUT` · `DELETE /api/follows/:type/:id` | `type` is `player` (id = PUUID) or `org`: follower count and whether you follow · follow · unfollow |
| `GET /api/players/:region/:riotId/teams` | team history: `{ veridium, selfReported }` |
| `POST` · `DELETE /api/players/:region/:riotId/teams[/:id]` | the player's own account: add `{ team, role?, game?, started, ended? }` (YYYY-MM) · remove |
| `PUT /api/auth/me/email-notifications` | `{ enabled }`: email copies of your notifications |
| `GET /api/organizers/me` · `POST /api/organizers` | your organizer profile and its status · apply: `{ name, website?, description? }` |
| `GET /api/organizers/:id` | an approved organizer's public profile and tournaments |
| `GET /api/admin/organizers?status=` · `POST /api/admin/organizers/:id` | Veridium staff: applications with the applicant's email · `{ status: approved \| rejected }` |
| `GET /api/tournaments` · `GET /api/tournaments/mine` | approved organizers' tournaments, newest first, with the top 3 · your own |
| `GET /api/tournaments/:id` | a tournament and its results (its organizer also sees results marked "Not me") |
| `POST /api/tournaments` · `DELETE /api/tournaments/:id` | approved organizers: `{ name, game, date (YYYY-MM-DD, not in the future), region?, url? }` · delete their own |
| `POST /api/tournaments/:id/results` · `DELETE …/results/:resultId` | the tournament's organizer: `{ riotId, region? = na1, placement, team? }` · remove |
| `POST /api/tournaments/results/:resultId/not-me` | the player's own account: hide a result and notify the organizer |
| `GET /api/players/:region/:riotId/tournaments` | a player's visible results |
| `GET /api/players/:region/:riotId/lol` | League of Legends ranked profile for the current season (`?cached=1` for cache only) |
| `GET /api/feed?limit=&following=1` | home feed (`following=1`: only players and orgs you follow): TFT and League of Legends sessions (one per player per game per day; LoL remakes left out), roster joins, vacancies |

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
CLI or tests), and each is recorded in `schema_migrations`. `001_pipeline.sql` is the
pipeline schema with `IF NOT EXISTS`, so databases from before migrations existed adopt it
unchanged. To change the schema, add the next numbered file. Never edit one that has already shipped.

### Riot developer policy

Checked against Riot's "Please Don't / Please Do" developer policy (October 2026):

- **Development key = private prototype.** Keep `SITE_PASSWORD` set and the audience small until
  Riot approves a production key. Removing the password is a launch, and needs the production key first.
  The GCP `create` command requires a password, and the server warns at startup in production without one.
- **Key stays server-side.** Only `src/riot/client.ts` sends it, as the `X-Riot-Token` header. It's never in
  the browser or the repository (`.env` is gitignored).
- **Documented endpoints only:** account-v1 (by Riot ID), tft-match-v1, tft-league-v1 (by PUUID),
  lol match-v5 and league-v4 (entries by PUUID).
- **No home-made rating.** Ranks, LP, wins and losses are Riot's values passed through. Rank comparisons
  only sort lists; no score, percentile or MMR is shown.
- **No player-rates-player feature.** Org decisions on applications are private to the player and the org.
  "Not me" only lets a player hide a result recorded for their own Riot ID. Check this rule before adding
  anything like endorsements or reviews.
- **No Riot logos or look-alike design.** There are no Riot or game logos; game tags are plain text.
  The site says it's an independent site using Riot's public API and isn't endorsed by Riot Games, and
  no copy says Riot verified, approved or partnered with Veridium.
- **No paid features** (see Free vs paid features below).
- **One production key per project:** a later, separate product needs its own key.

### Open decisions

- **Riot ID ownership.** Linking a Riot ID isn't proven yet (needs Riot Sign On). See Accounts above.
- **More than one admin per org.** The creator is the only admin; there's no way to invite others yet.
- **Free vs paid features.** Riot's developer policy doesn't allow charging money or giving paid-only
  access to any part of a product built on its API, so paid vacancy postings or paid profile features
  (such as "who viewed your profile") aren't allowed as things stand.
- **Obscurity Esports** was a test org from an old seed script; migration `007_remove_test_org.sql` removes it.

## Deploying (Google Cloud free VM)

The primary host is one **Always Free e2-micro** VM on Google Cloud, with a persistent data disk for
the sqlite database, served over HTTPS by Caddy at `https://<ip>.sslip.io` (free certificate, no
domain needed). Everything is in [`deploy/gcp/`](deploy/gcp/README.md): run
`bash deploy/gcp/veridium-gcp.sh create` in Google Cloud Shell. Afterwards, `set-key` takes the daily
Riot key, `deploy` ships new code and `verify` runs the crash and reboot test. The Render setup below
stays as a fallback.

## Deploying (Render, fallback)

The app is one Node process plus a sqlite file, so it needs a host with a **persistent disk**.
Serverless hosts (Vercel, Netlify functions) won't work, because the database would vanish
between requests. The repo is set up for [Render](https://render.com):

- `veridium-pipeline/Dockerfile` builds the app. On every boot it applies new migrations and
  starts the server.
- `render.yaml` (a Render Blueprint) declares the web service, a 1 GB disk mounted at
  `/var/data`, `DB_PATH=/var/data/veridium.db` on that disk, and the env vars to fill in.
  Disks need a paid instance type, so the Blueprint uses `starter`. Check Render's current pricing.

**First deploy**

1. Get this work onto `main`, since the Blueprint deploys `main`. The repo has no `main` yet, so create
   it from this branch on GitHub (or merge into it once it exists).
2. In Render: **New → Blueprint**, connect the `veridium-placeholder` GitHub repo, and apply.
3. When prompted, set **`RIOT_API_KEY`** (the bare `RGAPI-…` key) and **`SITE_PASSWORD`**.
4. Render builds the image and gives you an `https://veridium-….onrender.com` URL. Visit
   `/api/health` (open without the password), then sign up and create your organization.

**Production settings**

| Variable | |
| --- | --- |
| `RIOT_API_KEY` | set in Render's dashboard; never committed (`.env` is gitignored) |
| `DB_PATH` | `/var/data/veridium.db`, which must sit on the disk mount or data is lost on redeploy |
| `SEASONS` | `3` |
| `SITE_PASSWORD` | puts the whole site behind a browser password prompt. Required while on a Riot development key (Riot only allows those on a private prototype), and recommended while Riot ID ownership isn't verified |
| `CONTACT_EMAIL` | the address shown on the Privacy Policy and Terms for privacy and account requests |
| `ADMIN_EMAILS` | your account email(s): Veridium staff, who verify organizations and approve tournament organizers |
| `BREVO_API_KEY`, `EMAIL_FROM` | email notifications (optional). Create a free Brevo account, verify a sender address under Senders, and create an API key. `EMAIL_FROM` is that sender, e.g. `Veridium <noreply@yourdomain>` |
| `SITE_URL` | the site's address, e.g. `https://veridium.onrender.com`, for links in emails |
| `PORT` | injected by Render; the app reads `process.env.PORT` (4000 is only the local default) |
| `HOST` | `0.0.0.0` by default, so Render can route traffic in |

**Daily key rotation.** A Riot development key expires every 24 hours, on the deployed site too.
Update `RIOT_API_KEY` in Render each day (Render restarts the service with the new value), or
profile lookups fail for every visitor. Cached profiles still display, with a notice. A Riot
production key is the only permanent fix, and the deployed prototype is good evidence for that
application.
