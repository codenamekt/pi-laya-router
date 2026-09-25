# Review handoff: role-based config for pi-laya-router

Untracked scratch note for the reviewing agent. Do not commit it; delete after review.

## What changed and why

The router used to map four hard-coded "intents" to one model and one optional skill each,
and a user `intents` block replaced the defaults wholesale. It now routes to **roles**: a
name, a short description (which is the classifier's criteria), a model chain, and a list of
skills. Roles load from layered config files, are validated with every problem reported
rather than thrown, and can be reloaded without restarting Pi.

Working tree vs `b717cea` (last commit): 8 files changed, 3 new. 24 unit tests pass.
The end-to-end RPC test passes against the live proxy and Laya server.

### New files

- `extension/roles.ts` (pure, no I/O): `Role` type, `DEFAULT_ROLES`, `normalizeRole`
  (validation + legacy `model`/`skill`/`criteria` acceptance), `mergeRoles` (per-role merge,
  `null` removes), `pickModel` (first model not failed within `retryAfterMs`, else least
  recently failed, with a `healthy` flag), `parseLabel` (exact match, then longest contained
  id), `formatIssue`.
- `extension/roles.test.ts`: chain picking, label parsing, shorthand/legacy normalization,
  merge semantics.
- `laya-router.schema.json`: JSON Schema (draft-07) for editor validation. The `$id` and the
  example's `$schema` point at the raw GitHub URL on `main`, so they resolve only after push.

### Modified files

- `extension/config.ts`: layered loading (`configLayers`): user file (or
  `LAYA_ROUTER_CONFIG`), its sibling `.d/*.json` sorted, `<cwd>/.pi/laya-router.json`, its
  `.d/`. `buildConfig(layers)` is exported for tests. Sections merge field by field via a
  typed `pick()` with numeric ranges. **Semantics to confirm:** the first layer that defines
  `roles` (or legacy `intents`) starts the set; built-in roles apply only when no layer
  defines any. `RouterConfig` gained `chain`, `defaultRole`, `roles`, `sources`, `issues`.
  Deprecated keys (`intents`, `defaultIntent`, per-role `model`/`skill`/`criteria`) still
  load with warnings.
- `extension/classifier.ts`: criteria come from enabled roles' `description`; the LLM
  fallback label is parsed with `parseLabel` instead of `String.includes`. The old test that
  forbade role ids being substrings of one another was removed because of this.
- `extension/index.ts`:
  - `cfg` is `let`; `/router reload` re-reads it and clears failure marks.
  - `before_provider_request` records `lastSentModel`; model comes from `pickModel`.
  - `turn_end`: an assistant message with `stopReason === "error"` marks `lastSentModel`
    failed, so Pi's own auto-retry lands on the next chain entry.
  - `agent_before_settle`: on `outcome === "error"`, marks the model failed and, if the chain
    has another healthy model and fewer than `models.length - 1` failovers happened this user
    turn, returns a `context_edit` (replacement `null`) for the errored assistant entry plus
    `continue: true`. Without the omission Pi refuses the continuation (`canContinue` needs
    the last context message not to be an assistant message). Verified live with a bogus
    first model: 400 → omission → re-run on the second model → answer.
  - `before_agent_start`: writes `event.systemPromptOptions.sections.laya_router` instead of
    returning a replaced `systemPrompt` (Pi docs prefer sections). Only skills Pi actually
    advertises (`systemPromptOptions.skills`) are named; `knownSkills` is remembered for
    `/router roles`.
  - Commands: `roles` (alias `intents`), `config` (layers + issues), `reload`; `force` takes a
    role id. A one-line notice at `session_start` when the config has issues.
  - `state.intent` still holds the role id (policy.ts and the decision log are unchanged for
    compatibility).
- `laya-router.example.json`: new format, matches `DEFAULTS` (tested). Default ids stay
  `coding`, `planning`, `ui_ux`, `chat`: the id text steers Laya (`ui_ux` scored 0.72 vs
  `designer` 0.52 on "make the button blue"). Names are Coder/Planner/Designer/Chat.
- `scripts/classify.sh`: reads `roles` (falls back to `intents`), skips disabled roles.
- `scripts/rpc-switch-test.py`: passes `--no-extensions` plus each extension from the user's
  settings except this repo's (settings.json already lists it, so `-e` alone loaded it
  twice); borrows `headroom`/`laya`/`fallback` from the user's real config (the example
  points at localhost); waits for the prompt's own `response` → `agent_end` →
  `agent_settled` (Pi emits a startup `agent_settled` that the old count-based wait mistook
  for turn 1).
- `README.md`: roles, chains, layers, commands, the double-loading note.

## Please review specifically

1. **Failover boundary handling** (`index.ts`, `agent_before_settle`): is appending a
   `context_edit` for the errored assistant entry and returning `continue: true` the right
   contract for this Pi version (0.87.1 installed; types checked against GitHub `main`)? The
   omission mirrors Pi's own `_omitRecoveryAttempt`. Consider whether a context-overflow
   error should be excluded from failover (Pi handles overflow by compaction; failing over
   just moves the same context to another model).
2. **`turn_end` marking on any error**: user aborts are `"aborted"` not `"error"`, but any
   other error (including auth/config mistakes) parks the model for `retryAfterMs`. Is that
   acceptable, or should only 5xx/429/network mark it?
3. **Role-set semantics**: "first layer with roles replaces built-ins, later layers merge".
   Alternative would be always merging with built-ins. Chosen because the example file
   contains every default and a user deleting a role from their file expects it gone.
4. **Prompt section vs replacement**: `sections.laya_router` changes what the model sees
   (XML-wrapped section instead of a trailing `## Router mode` heading). Confirm nothing
   relied on the old text.
5. **Laya token budget**: the English checkpoint has a 512-token budget for state + question.
   Ten enabled roles (the user's live config) fit in practice (8/10 test prompts correct,
   rest handled by the LLM fallback), but truncation behaviour when over budget was not
   examined. `PROMPT_CHARS`/`RECENT_CHARS` in classifier.ts are unchanged.
6. **No type-check ran**: Pi ships as a bundled binary with no `.d.ts` on this machine, so
   `index.ts` was verified only at runtime (tests + RPC runs), not with `tsc`.
7. **Version**: `package.json` is still 0.1.0; this is a config-format change with
   deprecations, so 0.2.0 is reasonable.

## Out-of-repo changes (not part of the commit)

- `~/.pi/agent/laya-router.json` rewritten in the new format with 11 roles modeled on the
  Hermes profiles (`~/.hermes/profiles/*`); previous file at `laya-router.json.bak`.
- Seven Hermes skills copied into `~/.pi/agent/skills/`: test-driven-development,
  systematic-debugging, design-md, popular-web-designs, config-env-completeness,
  requesting-code-review, architecture-diagram.

## Suggested commit

    Route to configurable roles: layered config, model chains, skills, /router reload

    Roles replace intents: name, description (classifier criteria), model chain with
    failover, skills. Config layers (user, drop-ins, project) merge per role and are
    validated with issues reported via /router config. JSON schema, README, tests.
    Legacy intents/model/skill/criteria still load with deprecation warnings.

Verify before pushing: `node --test extension/*.test.ts` and, with Laya and the proxy up,
`scripts/rpc-switch-test.py` (needs `~/.pi/agent/laya-router.json` to point at the proxy).
