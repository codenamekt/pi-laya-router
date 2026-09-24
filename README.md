# pi-laya-router

Intent router for the [Pi](https://github.com/earendil-works/pi) coding agent, powered by
[Laya](https://github.com/NandhaKishorM/laya), a small local classifier.

Pick `laya/auto` as your model. Each prompt is classified as `coding`, `planning`, `ui_ux`
or `chat`, and the request goes to the model you mapped to that intent on your
OpenAI-compatible proxy (LiteLLM, Headroom, anything with `/v1/chat/completions`). Pi keeps
showing `laya/auto`. When the kind of work changes for a couple of turns in a row, the
session is compacted with a note about the move and the model is told which skill to lean on.

## Install

```bash
git clone https://github.com/codenamekt/pi-laya-router
cd pi-laya-router
scripts/install.sh   # laya via uv (Python 3.12), systemd user unit on :8811, config template
```

Then edit `~/.pi/agent/laya-router.json`: set `headroom.baseUrl` to your proxy, and map each
intent to a model id the proxy knows. The API key comes from `HEADROOM_API_KEY` (or
`~/.config/headroom/env`).

Try it with `pi -e ./extension`, then `/model laya/auto`. To keep it, add
`<repo>/extension/index.ts` to `extensions` in `~/.pi/agent/settings.json`.

## Commands

```
/router                 status
/router force planning  pin an intent
/router clear           unpin
/router off | on        pause / resume classification
```

## How it decides

- Laya answers one multiple-choice question about the latest prompt in ~35 ms on a GPU.
  If it is unsure or down, a one-line classification runs through `fallback.model`
  (use a non-reasoning model there).
- A switch needs two consecutive turns at >=0.70 confidence, or one at >=0.90, plus a 0.15
  margin over the runner-up and three turns since the last switch. Tune under `thresholds`.
- Compaction happens on a switch only in interactive modes and only above
  `compactMinTokens` (Pi keeps the last 20k tokens verbatim, so the default is 24k).
- Picking any other model pauses routing. Pick `laya/auto` again to resume.
- Every decision is appended to `~/.pi/agent/laya-router/decisions.jsonl`. Laya's base
  checkpoint is not tuned for this, so once you have a few hundred rows, fine-tune with
  Laya's notebook and point `laya.model` at the result.

## Test

```bash
node --test extension/*.test.ts     # policy + config
scripts/classify.sh "plan the auth migration"
scripts/rpc-switch-test.py          # drives Pi over RPC through a forced switch and compaction
```

Public domain, see LICENSE.
