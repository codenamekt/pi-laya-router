#!/usr/bin/env bash
# Idempotent local install: Laya server as a user service, example config, and
# a pointer for wiring the extension into Pi.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
CONFIG="$HOME/.pi/agent/laya-router.json"

if ! command -v laya-serve >/dev/null 2>&1; then
  echo "installing laya (Python 3.12 via uv)…"
  uv tool install --python 3.12 "laya[serve]"
fi

mkdir -p "$UNIT_DIR"
cp "$REPO/service/laya-serve.service" "$UNIT_DIR/laya-serve.service"
systemctl --user daemon-reload
systemctl --user enable --now laya-serve.service
echo "laya-serve: $(systemctl --user is-active laya-serve.service) on http://127.0.0.1:8811"

if [ ! -f "$CONFIG" ]; then
  cp "$REPO/laya-router.example.json" "$CONFIG"
  echo "wrote $CONFIG"
else
  echo "keeping existing $CONFIG"
fi

cat <<EOF

Next:
  test:     pi -e $REPO/extension     then /model laya/auto
  install:  add "$REPO/extension/index.ts" to the "extensions" list in ~/.pi/agent/settings.json
  smoke:    $REPO/scripts/classify.sh "refactor the auth module"
EOF
