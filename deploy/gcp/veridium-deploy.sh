#!/bin/bash
# Pulls the configured branch and reinstalls production dependencies. The caller restarts the app
# (veridium-config does, after any deploy). Run by hand with: sudo veridium-deploy && sudo systemctl restart veridium
set -euo pipefail
APP=/opt/veridium
MD_URL=${VERIDIUM_METADATA_URL:-http://metadata.google.internal/computeMetadata/v1/instance/attributes/}  # override only in tests
md() { curl -fsS -H 'Metadata-Flavor: Google' "$MD_URL$1" 2>/dev/null || true; }
BRANCH=$(md veridium-branch); BRANCH=${BRANCH:-main}

cd "$APP"
sudo -u veridium git fetch --quiet origin "$BRANCH"
sudo -u veridium git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
cd veridium-pipeline
sudo -u veridium npm ci --omit=dev --no-audit --no-fund
# Pick up changes to the service files or helper scripts shipped with the code.
install -m 755 "$APP/deploy/gcp/veridium-config.sh" /usr/local/bin/veridium-config
install -m 644 "$APP/deploy/gcp/veridium.service" /etc/systemd/system/veridium.service
systemctl daemon-reload
logger -t veridium-deploy "deployed $BRANCH at $(git -C "$APP" rev-parse --short HEAD)"
