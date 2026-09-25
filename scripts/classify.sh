#!/usr/bin/env bash
# Smoke test the Laya server with the roles from your main config file (drop-ins
# and project layers are not merged here; use /router roles inside Pi for that).
#   scripts/classify.sh "add a retry loop to the fetch helper"
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${LAYA_ROUTER_CONFIG:-$HOME/.pi/agent/laya-router.json}"
[ -f "$CONFIG" ] || CONFIG="$REPO/laya-router.example.json"
TEXT="${1:?usage: classify.sh \"<request text>\"}"

python3 - "$CONFIG" "$TEXT" <<'EOF'
import json, sys, urllib.request
cfg = json.load(open(sys.argv[1]))
text = sys.argv[2]
url = cfg.get("laya", {}).get("url", "http://127.0.0.1:8811")
body = {
    "model": cfg.get("laya", {}).get("model", "english"),
    "state": {"request": text, "previous": ""},
    "questions": {"intent": {"type": "choice",
        "instructions": "What kind of work is the user asking the coding agent to do right now?",
        "criteria": {k: v.get("description", v.get("criteria")) for k, v in (cfg.get("roles") or cfg.get("intents", {})).items()
                     if isinstance(v, dict) and v.get("enabled", True)}}}}
req = urllib.request.Request(f"{url}/v1/systemone", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
with urllib.request.urlopen(req, timeout=30) as r:
    a = json.load(r)["answers"]["intent"]
print(f"{a['choice']}  top={max(a['probabilities'].values()):.3f}  probs={a['probabilities']}")
EOF
