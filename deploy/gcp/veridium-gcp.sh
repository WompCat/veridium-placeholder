#!/usr/bin/env bash
# Veridium on a Google Cloud "Always Free" e2-micro VM. Run it in Google Cloud Shell
# (console.cloud.google.com → the >_ icon), where gcloud is already installed and logged in.
#
#   bash deploy/gcp/veridium-gcp.sh create    create the VM, data disk, static IP and firewall rule (HTTPS via Caddy)
#   bash deploy/gcp/veridium-gcp.sh set-key   paste a new Riot API key (dev keys expire every 24h)
#   bash deploy/gcp/veridium-gcp.sh deploy    pull the latest code on the VM and restart
#   bash deploy/gcp/veridium-gcp.sh verify    crash test + reboot test, checking the site and its data survive
#   bash deploy/gcp/veridium-gcp.sh status    address, health, and recent app logs
#
# Overrides: PROJECT (default: gcloud's current project), ZONE (default us-central1-a), BRANCH (default main).
set -euo pipefail

PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null)}
ZONE=${ZONE:-us-central1-a}
REGION=${ZONE%-*}
BRANCH=${BRANCH:-main}
REPO=https://github.com/WompCat/veridium-placeholder.git
NAME=veridium
BOOT_GB=10   # Debian's minimum
DATA_GB=10   # the sqlite database lives here; kept if the VM is ever deleted
HERE=$(cd "$(dirname "$0")" && pwd)

g() { gcloud --project "$PROJECT" "$@"; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
ip() { g compute addresses describe "$NAME-ip" --region "$REGION" --format='value(address)'; }
# The site's address: <ip>.sslip.io, a free hostname that resolves to the IP inside it, so the VM can
# get a real HTTPS certificate without a domain. A `veridium-domain` metadata value overrides it on the VM.
site() { local a; a=$(ip); echo "https://${a//./-}.sslip.io"; }

# Set a metadata value from a file, so passwords with commas or spaces survive gcloud's parsing.
set_secret() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp); chmod 600 "$tmp"; printf '%s' "$value" > "$tmp"
  g compute instances add-metadata "$NAME" --zone "$ZONE" --metadata-from-file "$key=$tmp" >/dev/null
  rm -f "$tmp"
}

wait_healthy() {
  local url; url="$(site)/api/health"
  printf 'Waiting for %s ' "$url"
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then echo ' up'; return 0; fi
    printf '.'; sleep 10
  done
  echo; die "Not healthy after 15 minutes. Check: bash $0 status"
}

# Refuse anything outside the Always Free limits before creating it.
preflight() {
  [ -n "$PROJECT" ] || die "No project selected. Run: gcloud config set project YOUR_PROJECT_ID"
  case "$REGION" in
    us-west1|us-central1|us-east1) ;;
    *) die "$REGION isn't an Always Free region (us-west1, us-central1, us-east1). Set ZONE, e.g. ZONE=us-central1-a" ;;
  esac
  [ $((BOOT_GB + DATA_GB)) -le 30 ] || die "Disks total $((BOOT_GB + DATA_GB)) GB; the free tier covers 30 GB of standard disk"
  local micros
  micros=$(g compute instances list --filter='machineType~e2-micro' --format='value(name)' | grep -vx "$NAME" || true)
  [ -z "$micros" ] || die "This project already runs an e2-micro ($micros). Only one is free."
  git ls-remote --exit-code --heads "$REPO" "$BRANCH" >/dev/null \
    || die "Branch '$BRANCH' doesn't exist on GitHub yet. Create it, or run with BRANCH=claude/build-order-review-rbzbu7"
  cat <<EOF

About to create, in project $PROJECT:
  • VM "$NAME": e2-micro, zone $ZONE, Debian 12        (Always Free: 1 e2-micro in us-west1/us-central1/us-east1)
  • Disks: ${BOOT_GB} GB boot + ${DATA_GB} GB data, both pd-standard  (Always Free: 30 GB standard persistent disk)
  • Static IP "$NAME-ip" in $REGION, firewall rule allowing HTTP and HTTPS (ports 80, 443)
  • HTTPS: Caddy on the VM gets a free certificate for <ip>.sslip.io and redirects HTTP to HTTPS
  • Code: $REPO @ $BRANCH

Before you continue, check two things in the Cloud console:
  1. Billing → Budgets & alerts: add a small budget (e.g. \$1) with email alerts, so any charge emails you.
  2. Google's current price for an external IPv4 address on a free-tier VM. Google started billing
     external IPv4 addresses in 2024; if it applies to yours it's roughly \$3–4/month.
EOF
  read -rp "Create it? [y/N] " ok
  [ "$ok" = y ] || [ "$ok" = Y ] || die "Cancelled."
}

cmd_create() {
  preflight
  local riot site contact
  read -rsp "Riot API key (RGAPI-…): " riot; echo
  [ -n "$riot" ] || die "A Riot API key is required (developer.riotgames.com)"
  read -rsp "Site password (no ' quotes; leave blank to skip, not recommended): " site; echo
  read -rp  "Contact email for the Privacy Policy (optional): " contact

  say "Enabling the Compute Engine API"
  g services enable compute.googleapis.com

  say "Static IP"
  g compute addresses describe "$NAME-ip" --region "$REGION" >/dev/null 2>&1 \
    || g compute addresses create "$NAME-ip" --region "$REGION"
  echo "IP: $(ip)"

  say "Firewall: allow HTTP and HTTPS to VMs tagged $NAME-web"
  g compute firewall-rules describe "$NAME-web" >/dev/null 2>&1 \
    || g compute firewall-rules create "$NAME-web" --allow tcp:80,tcp:443 --target-tags "$NAME-web" --source-ranges 0.0.0.0/0

  say "Data disk"
  g compute disks describe "$NAME-data" --zone "$ZONE" >/dev/null 2>&1 \
    || g compute disks create "$NAME-data" --zone "$ZONE" --size "${DATA_GB}GB" --type pd-standard

  say "VM (it installs Node and the app on first boot: allow ~5–10 minutes)"
  # Secrets go in as files (never on the command line), and only the ones that were given.
  local secrets files; secrets=$(mktemp -d); chmod 700 "$secrets"
  files="startup-script=$HERE/startup.sh"
  [ -n "$riot" ] && printf '%s' "$riot" > "$secrets/riot" && files+=",veridium-riot-api-key=$secrets/riot"
  [ -n "$site" ] && printf '%s' "$site" > "$secrets/site" && files+=",veridium-site-password=$secrets/site"
  [ -n "$contact" ] && printf '%s' "$contact" > "$secrets/contact" && files+=",veridium-contact-email=$secrets/contact"
  g compute instances create "$NAME" --zone "$ZONE" \
    --machine-type e2-micro \
    --image-family debian-12 --image-project debian-cloud \
    --boot-disk-size "${BOOT_GB}GB" --boot-disk-type pd-standard \
    --disk "name=$NAME-data,device-name=$NAME-data,mode=rw,auto-delete=no" \
    --address "$(ip)" --tags "$NAME-web" \
    --metadata "veridium-repo=$REPO,veridium-branch=$BRANCH" \
    --metadata-from-file "$files"
  rm -rf "$secrets"

  wait_healthy
  say "Veridium is live at $(site)/"
  echo "(http:// redirects there. It's behind the site password you set.)"
  echo "Next: bash $0 verify   (crash + reboot test)"
}

cmd_set_key() {
  local riot
  read -rsp "New Riot API key (RGAPI-…): " riot; echo
  set_secret veridium-riot-api-key "$riot"
  echo "Saved. The VM picks it up and restarts the app within a few seconds."
}

cmd_deploy() {
  g compute instances add-metadata "$NAME" --zone "$ZONE" --metadata "veridium-branch=$BRANCH,veridium-deploy=$(date -u +%Y%m%dT%H%M%SZ)" >/dev/null
  echo "Deploy requested ($BRANCH). The VM pulls, installs and restarts; this takes a minute or two."
  sleep 20; wait_healthy
}

# Counts loaded players through the API (behind the site password if one is set).
players() {
  local pw; pw=$(g compute instances describe "$NAME" --zone "$ZONE" --format=json \
    | python3 -c 'import json,sys; m={i["key"]: i.get("value","") for i in json.load(sys.stdin)["metadata"].get("items",[])}; print(m.get("veridium-site-password",""))')
  curl -fsS --max-time 10 ${pw:+-u "veridium:$pw"} "$(site)/api/players" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'
}

cmd_verify() {
  local before after
  wait_healthy
  before=$(players); echo "Players stored: $before"

  say "Crash test: kill the app process"
  g compute ssh "$NAME" --zone "$ZONE" --command 'sudo systemctl kill -s SIGKILL veridium.service' >/dev/null
  sleep 8; wait_healthy

  say "Reboot test: reset the VM"
  g compute instances reset "$NAME" --zone "$ZONE" >/dev/null
  sleep 30; wait_healthy
  after=$(players); echo "Players stored: $after"
  [ "$after" = "$before" ] || die "Data changed across the reboot ($before → $after)"
  say "Passed: the app restarts after a crash and a reboot, and the database survives."
}

cmd_status() {
  echo "URL: $(site)/"
  curl -fsS --max-time 5 "$(site)/api/health" && echo || echo "health: not responding"
  g compute ssh "$NAME" --zone "$ZONE" --command 'systemctl is-active veridium veridium-config caddy; sudo journalctl -u veridium -u caddy -n 30 --no-pager'
}

case "${1:-}" in
  create) cmd_create ;;
  set-key) cmd_set_key ;;
  deploy) cmd_deploy ;;
  verify) cmd_verify ;;
  status) cmd_status ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
