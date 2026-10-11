# Veridium on Google Cloud's free VM

Runs Veridium on one **Always Free e2-micro** VM with its own persistent disk, so the sqlite database
survives restarts and redeploys. It's served over **HTTPS** from the first boot, at `https://<ip>.sslip.io`. `render.yaml` and the Dockerfile stay in the repo as the fallback host.

Everything is driven by one script, run in **Google Cloud Shell**. Cloud Shell is the `>_` icon at the
top of the Cloud console: a browser terminal where `gcloud` is already installed and logged in as you,
so nothing needs installing and no keys leave Google.

## One-time setup

1. **Account and project.** Create a Google Cloud account (a card is required for verification),
   create a project, and select it at the top of the console.
2. **Budget alert.** Billing → Budgets & alerts → create a budget of e.g. $1 with email alerts. If
   anything ever falls outside the free tier, you hear about it instead of finding out on a bill.
3. **Open Cloud Shell and run:**

   ```bash
   git clone https://github.com/WompCat/veridium-placeholder.git && cd veridium-placeholder
   bash deploy/gcp/veridium-gcp.sh create
   ```

   It first checks the free-tier limits and shows exactly what it will create:
   - one e2-micro;
   - in `us-central1` (or `us-west1` / `us-east1`);
   - 10 GB boot disk plus 10 GB data disk, both standard (the free tier covers 30 GB);
   - a static IP and a firewall rule for HTTP and HTTPS.

   Then it asks for confirmation, your Riot key, a site password and an optional contact email.
   The VM installs everything on first boot (5–10 minutes) and the script waits until the site answers
   at `https://<ip-with-dashes>.sslip.io/` (for IP 34.1.2.3: `https://34-1-2-3.sslip.io/`). Plain
   `http://` redirects there.
4. **Prove it survives** a crash and a reboot with the data intact:

   ```bash
   bash deploy/gcp/veridium-gcp.sh verify
   ```

## Day to day

| Task | Command (in Cloud Shell, from the repo folder) |
|---|---|
| New Riot key (dev keys expire every 24h) | `bash deploy/gcp/veridium-gcp.sh set-key` |
| Deploy the latest code | `bash deploy/gcp/veridium-gcp.sh deploy` |
| Address, health, recent logs | `bash deploy/gcp/veridium-gcp.sh status` |

The Riot key, site password, contact email, staff emails and domain can also be changed without any
command: Compute Engine → VM instances → `veridium` → Edit → Metadata, edit `veridium-riot-api-key`,
`veridium-site-password`, `veridium-contact-email`, `veridium-admin-emails` (who can verify
organizations) or `veridium-domain`, and Save. The VM applies the change and restarts
the app within seconds.

## How it works

- **`startup.sh`** runs as root on every boot (it's the VM's startup script). It:
  - mounts the data disk at `/var/lib/veridium` (formatting it the first time);
  - adds 1 GB of swap;
  - installs Node.js 22;
  - clones the repo to `/opt/veridium` on first boot, with production dependencies only;
  - installs the two services.
- **Caddy** (Debian's package) listens on ports 80 and 443:
  - gets and renews a free certificate for `<ip>.sslip.io` automatically;
  - redirects HTTP to HTTPS, adds HSTS and compression, and forwards to the app;
  - its config, `/etc/caddy/Caddyfile`, is written by the settings watcher.
- **`veridium.service`** runs the app on `127.0.0.1:3000`, reachable only through Caddy:
  - as an unprivileged `veridium` user, with no special privileges;
  - restarts 3 seconds after a crash, and starts on boot;
  - can only write to its database directory.
- **`veridium-config.service`** watches the VM's metadata:
  - when a setting changes, it rewrites `/etc/veridium/veridium.env` (root-only) and restarts the app,
    and rewrites the Caddyfile and reloads Caddy if the hostname changed;
  - when `veridium-deploy` changes, it pulls the code first (`veridium-deploy.sh`).
  - A value containing a `'` or a newline is refused and the previous settings stay. A bad password
    never turns the site password off.

Settings live in instance metadata, which only people with access to your Google Cloud project can
read. They're never in the repo.

## Before you rely on it

- **External IP cost.** Google began charging for external IPv4 addresses in 2024. Check the current
  pricing for your VM's address (the budget alert above will catch it either way). If it's charged,
  it's roughly $3–4 a month.
- **Custom domain later.** Point the domain's DNS `A` record at the static IP, then set the VM's
  `veridium-domain` metadata to it (Edit → Metadata). Caddy gets a certificate for it automatically.
- **Daily Riot key.** The development key still expires every 24 hours: `set-key` each day until Riot
  issues a production key.
