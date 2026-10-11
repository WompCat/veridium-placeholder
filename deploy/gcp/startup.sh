#!/bin/bash
# Veridium VM bootstrap. Google Compute Engine runs this as root on every boot (it's the
# instance's `startup-script` metadata), so every step is idempotent:
#   1. mount the data disk (formatted on first boot) at /var/lib/veridium: the sqlite db lives here
#   2. add 1 GB of swap (an e2-micro has 1 GB of RAM; npm installs need headroom)
#   3. install Node.js 22 and git
#   4. clone the repo (first boot only; later deploys go through veridium-deploy)
#   5. install the services: veridium (the app) and veridium-config (applies setting changes)
# Settings and secrets come from instance metadata (see deploy/gcp/README.md), never from the repo.
set -euo pipefail
exec > >(logger -t veridium-startup) 2>&1

APP=/opt/veridium
DATA=/var/lib/veridium
CONF=/etc/veridium
DISK=/dev/disk/by-id/google-veridium-data

# ---- 1. Data disk ----
if [ -e "$DISK" ]; then
  blkid "$DISK" >/dev/null 2>&1 || mkfs.ext4 -q -m 0 -F "$DISK"
  mkdir -p "$DATA"
  grep -q "$DISK" /etc/fstab || echo "$DISK $DATA ext4 discard,defaults,nofail 0 2" >> /etc/fstab
  mountpoint -q "$DATA" || mount "$DATA"
else
  echo "WARNING: data disk not attached; the database will live on the boot disk" >&2
  mkdir -p "$DATA"
fi

# ---- 2. Swap ----
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon -a || true

# ---- 3. Node.js 22 + git ----
if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg git build-essential python3
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# ---- 4. App user and code ----
id veridium >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin veridium
mkdir -p "$CONF" "$APP"
chown veridium:veridium "$DATA" "$APP"
chmod 750 "$DATA"
MD_URL=${VERIDIUM_METADATA_URL:-http://metadata.google.internal/computeMetadata/v1/instance/attributes/}  # override only in tests
md() { curl -fsS -H 'Metadata-Flavor: Google' "$MD_URL$1" 2>/dev/null || true; }
if [ ! -d "$APP/.git" ]; then
  REPO=$(md veridium-repo); BRANCH=$(md veridium-branch)
  sudo -u veridium git clone --branch "${BRANCH:-main}" "${REPO:-https://github.com/WompCat/veridium-placeholder.git}" "$APP"
  (cd "$APP/veridium-pipeline" && sudo -u veridium npm ci --omit=dev --no-audit --no-fund)
fi

# ---- 5. Helper scripts and services (refreshed from the repo on every boot) ----
install -m 755 "$APP/deploy/gcp/veridium-config.sh" /usr/local/bin/veridium-config
install -m 755 "$APP/deploy/gcp/veridium-deploy.sh" /usr/local/bin/veridium-deploy
install -m 644 "$APP/deploy/gcp/veridium.service" /etc/systemd/system/veridium.service
install -m 644 "$APP/deploy/gcp/veridium-config.service" /etc/systemd/system/veridium-config.service
/usr/local/bin/veridium-config --once || echo "WARNING: settings not applied (see: journalctl -t veridium-config)" >&2
systemctl daemon-reload
systemctl enable --now veridium.service veridium-config.service
systemctl restart veridium.service       # pick up a fresh env file / code after a reboot or re-run
echo "Veridium is up on port 80"
