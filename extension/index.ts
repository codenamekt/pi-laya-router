/**
 * Laya intent router for Pi.
 *
 * Registers a `laya` provider with one model, `auto`. While `laya/auto`
 * is selected, every user turn is classified into one of the configured
 * roles (Laya locally, cheap LLM as fallback), a hysteresis policy decides
 * whether the kind of work changed, and the outgoing request's `model` is
 * rewritten to the first healthy model in the role's chain. On a switch the
 * session is compacted with instructions about the move, and the model gets
 * the role's hint plus the skills that go with it.
 *
 * Usage: pi -e /path/to/pi-laya-router/extension   then   /model laya/auto
 */
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { classify, type ClassifyResult } from "./classifier.ts";
import { configLayers, loadConfig, providerApiKey, type RouterConfig } from "./config.ts";
import { logDecision } from "./log.ts";
import { type Decision, decide, freshState, type RouterState } from "./policy.ts";
import { enabledRoles, formatIssue, pickModel, type Role } from "./roles.ts";
import { persist, recentUserTurns, restore } from "./state.ts";

const PROVIDER = "laya";
const MODEL_ID = "auto";
const RECENT_TURNS = 2;
const COMPACT_SLOW_MS = 60_000;

function checkExplicitSwitch(text: string, roles: Record<string, Role>): string | undefined {
	const lower = text.toLowerCase();
	for (const [id, role] of Object.entries(roles)) {
		if (!role.enabled) continue;
		const name = role.name.toLowerCase();
		const patterns = [
			`switch to ${id}`, `switch to ${name}`,
			`use ${id}`, `use ${name}`,
			`change to ${id}`, `change to ${name}`,
			`go to ${id}`, `go to ${name}`,
		];
		if (patterns.some((p) => lower.includes(p))) return id;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let cfg: RouterConfig = loadConfig();
	let state: RouterState = freshState();
	/** Set when a run should announce an adopt/switch to the model. */
	let pendingNotice: Decision | null = null;
	let last: ClassifyResult | null = null;
	/** Model id → time it last failed. Shared across roles: a model that is down is down. */
	const failed = new Map<string, number>();
	/** Model the last upstream request was rewritten to. */
	let lastSentModel: string | null = null;
	/** Chain failovers taken during the current user turn. */
	let failovers = 0;
	/** Skill names Pi advertised on the last run, for `/router roles` diagnostics. */
	let knownSkills: string[] = [];
	let issuesShown = false;

	// ---------------------------------------------------------------- helpers

	/** laya/auto is the selected model: always rewrite the upstream model. */
	const isDelegating = (ctx: ExtensionContext) => ctx.model?.provider === PROVIDER;
	/** ...and classification is not paused via /router off. */
	const isRouting = (ctx: ExtensionContext) => state.on && isDelegating(ctx);
	/** Compact-then-resend is asynchronous; print/json mode awaits a single prompt and would lose it. */
	const isInteractive = (ctx: ExtensionContext) => ctx.mode === "tui" || ctx.mode === "rpc";
	/** state.intent holds a role id; a stale or disabled one falls back to the default role. */
	const roleOf = (id: string | null): Role => (id && cfg.roles[id]?.enabled ? cfg.roles[id] : cfg.roles[cfg.defaultRole]);
	const currentRole = () => roleOf(state.intent);
	const targetModel = () => pickModel(currentRole(), failed, Date.now(), cfg.chain.retryAfterMs).model;
	const shortModel = (id: string) => id.split("/").pop() ?? id;
	const roleIds = () => Object.keys(enabledRoles(cfg.roles));

	function showIssues(ctx: ExtensionContext) {
		if (issuesShown || !ctx.hasUI || cfg.issues.length === 0) return;
		issuesShown = true;
		const errors = cfg.issues.filter((i) => i.level === "error").length;
		ctx.ui.notify(`Router config: ${cfg.issues.length} issue(s), ${errors} error(s). See /router config.`, errors ? "warning" : "info");
	}

	function showStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!state.on || ctx.model?.provider !== PROVIDER) {
			ctx.ui.setStatus("router", undefined);
			return;
		}
		const role = currentRole();
		const pending = state.candidate ? ` (${state.candidate.intent} ${state.candidate.n}/${cfg.thresholds.streak})` : "";
		const forced = state.forced ? " pinned" : "";
		const pick = pickModel(role, failed, Date.now(), cfg.chain.retryAfterMs);
		const chain = pick.index > 0 ? ` #${pick.index + 1}` : "";
		ctx.ui.setStatus("router", `⇄ ${role.id}${forced} · ${shortModel(pick.model)}${chain}${pending}`);
	}

	/** Skills the role asks for that Pi actually has (unknown until the first run; then trusted). */
	const availableSkills = (role: Role) => (knownSkills.length ? role.skills.filter((s) => knownSkills.includes(s)) : role.skills);

	function noticeText(d: Decision): string | null {
		if (d.kind !== "adopt" && d.kind !== "switch") return null;
		const role = roleOf(d.kind === "adopt" ? d.intent : d.to);
		const model = pickModel(role, failed, Date.now(), cfg.chain.retryAfterMs).model;
		const skills = availableSkills(role);
		const skillNote = skills.length ? ` · skills: ${skills.map((s) => `/skill:${s}`).join(", ")}` : "";
		const head = d.kind === "adopt" ? `role **${role.name}**` : `**${d.from} → ${d.to}** (${role.name})`;
		return `Laya router: ${head} → \`${model}\`${skillNote}`;
	}

	function compactInstructions(from: string, to: string): string {
		return (
			`The work is moving from ${from} to ${to}. Keep goals, decisions, constraints, file paths, ` +
			`open tasks and anything the ${to} phase needs. Summarize ${from} tool output in one short paragraph.`
		);
	}

	/**
	 * Compact, then re-send the user's prompt so the new model starts from the
	 * summary. Pi refuses prompts while compaction is in flight, so the prompt
	 * is only ever re-sent from the completion callbacks; the timer just warns.
	 */
	function compactThenResend(ctx: ExtensionContext, text: string, images: Array<{ type: string; [k: string]: unknown }> | undefined, from: string, to: string) {
		const resend = () => {
			const content = images?.length ? [{ type: "text" as const, text }, ...images] : text;
			pi.sendUserMessage(content as Parameters<typeof pi.sendUserMessage>[0], { expandPromptTemplates: false });
		};
		const slow = setTimeout(() => {
			if (ctx.hasUI) ctx.ui.notify("Router: compaction is taking a while; your prompt is queued behind it", "warning");
		}, COMPACT_SLOW_MS);
		if (ctx.hasUI) ctx.ui.notify(`Router: compacting for the move ${from} → ${to}…`, "info");
		ctx.compact({
			customInstructions: compactInstructions(from, to),
			onComplete: () => {
				clearTimeout(slow);
				resend();
			},
			onError: (error) => {
				clearTimeout(slow);
				if (ctx.hasUI) ctx.ui.notify(`Router: compaction failed (${error.message}); continuing without it`, "warning");
				resend();
			},
		});
	}

	// --------------------------------------------------------------- provider

	pi.registerProvider(PROVIDER, {
		name: "Laya",
		baseUrl: cfg.provider.baseUrl,
		apiKey: providerApiKey(),
		api: "openai-completions",
		models: [
			{
				id: MODEL_ID,
				name: "Auto (Laya intent router)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: cfg.autoModel.contextWindow,
				maxTokens: cfg.autoModel.maxTokens,
			},
		],
	});

	// The delegation: Pi keeps laya/auto selected, upstream sees the real model.
	pi.on("before_provider_request", (event, ctx) => {
		if (!isDelegating(ctx)) return;
		const payload = event.payload as { model?: unknown } | undefined;
		if (!payload || typeof payload !== "object" || typeof payload.model !== "string") return;
		lastSentModel = targetModel();
		return { ...payload, model: lastSentModel };
	});

	// Model chain failover. A model that errors is marked failed as soon as the
	// turn ends, so Pi's own auto-retry (429s, 5xx, dropped streams) already
	// lands on the next model in the chain. Errors Pi does not retry (a 400 for
	// an unknown model, say) reach agent_before_settle: the failed reply is
	// omitted from context, like Pi's retry does, and one more run is requested.
	const markFailed = (model: string) => {
		failed.set(model, Date.now());
		// Prune entries older than retryAfterMs to avoid unbounded growth.
		const now = Date.now();
		for (const [m, at] of failed) {
			if (now - at >= cfg.chain.retryAfterMs) failed.delete(m);
		}
	};

	pi.on("turn_end", (event, ctx) => {
		if (!isDelegating(ctx) || !lastSentModel) return;
		const msg = event.message as { role?: string; stopReason?: string };
		if (msg.role === "assistant" && msg.stopReason === "error") {
			markFailed(lastSentModel);
			if (ctx.hasUI) {
				const pick = pickModel(currentRole(), failed, Date.now(), cfg.chain.retryAfterMs);
				if (!pick.healthy) {
					ctx.ui.notify(`Router: all models in the ${currentRole().id} chain have failed recently; using least-recently-failed ${shortModel(pick.model)}`, "warning");
				}
			}
		}
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (!isDelegating(ctx) || event.outcome !== "error" || !lastSentModel) return;
		const role = currentRole();
		if (!role.models.includes(lastSentModel)) return;
		markFailed(lastSentModel);
		const next = pickModel(role, failed, Date.now(), cfg.chain.retryAfterMs);
		const failedEntry = [...event.context.contextEntries].reverse().find((e) => {
			const src = e.sourceEntry as { type: string; message?: { role?: string; stopReason?: string } };
			return src.type === "message" && src.message?.role === "assistant" && src.message.stopReason === "error";
		});
		const canFailover = cfg.chain.failover && next.healthy && next.model !== lastSentModel && failedEntry !== undefined && failovers < role.models.length - 1;
		if (ctx.hasUI) {
			ctx.ui.notify(
				canFailover
					? `Router: ${shortModel(lastSentModel)} failed; retrying on ${shortModel(next.model)} (${role.id} chain #${next.index + 1})`
					: `Router: ${shortModel(lastSentModel)} failed; no other healthy model in the ${role.id} chain`,
				"warning",
			);
		}
		showStatus(ctx);
		if (!canFailover) return;
		failovers++;
		return {
			entries: [...event.entries, { type: "context_edit", targetId: (failedEntry.sourceEntry as { id: string }).id, replacement: null }],
			continue: true,
		};
	});

	// Pi's built-in summarizer calls the provider directly, bypassing the payload
	// hook above, so it would send model "auto" upstream. While delegating, we
	// generate the summary ourselves with the real target model.
	pi.on("session_before_compact", async (event, ctx) => {
		if (!isDelegating(ctx)) return;
		const { preparation, customInstructions, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;
		const model =
			ctx.modelRegistry.find(cfg.provider.name, targetModel()) ??
			ctx.modelRegistry.find(cfg.provider.name, cfg.fallback.model);
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify(`Router: no summarizer model found under ${cfg.provider.name}; compaction cancelled`, "warning");
			return { cancel: true };
		}
		const conversation = serializeConversation(convertToLlm([...messagesToSummarize, ...turnPrefixMessages]));
		const prompt = `Summarize this coding-agent conversation so work can continue from the summary alone.
${customInstructions ? `\nFocus: ${customInstructions}\n` : ""}${previousSummary ? `\nEarlier summary (already applied, extend it):\n${previousSummary}\n` : ""}
Cover, as structured markdown: goals; decisions and why; files read or changed with paths; current state of the work; open questions or blockers; next steps.
Be concrete and concise. Do not continue the conversation.

<conversation>
${conversation}
</conversation>`;
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
				{ maxTokens: 4096, signal, cacheRetention: "none", sessionId: uuidv7() },
			);
			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();
			if (!summary) throw new Error("empty summary");
			return { compaction: { summary, firstKeptEntryId, tokensBefore, usage: response.usage } };
		} catch (err) {
			if (signal.aborted) return { cancel: true };
			if (ctx.hasUI) ctx.ui.notify(`Router: summary failed (${err instanceof Error ? err.message : err}); compaction cancelled`, "warning");
			return { cancel: true };
		}
	});

	// ----------------------------------------------------------------- events

	const onRestore = (_event: unknown, ctx: ExtensionContext) => {
		state = restore(ctx);
		showStatus(ctx);
	};
	pi.on("session_start", (event, ctx) => {
		onRestore(event, ctx);
		showIssues(ctx);
	});
	pi.on("session_tree", onRestore);

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("router", undefined);
	});

	pi.on("model_select", (event, ctx) => {
		const nowRouting = event.model.provider === PROVIDER;
		if (nowRouting && !state.on && event.source !== "restore") {
			state.on = true;
			persist(pi, state);
		}
		if (!nowRouting && event.source === "set" && ctx.hasUI) {
			ctx.ui.notify("Router paused: manual model selected. Pick laya/auto to resume.", "info");
		}
		showStatus(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (!isRouting(ctx)) return { action: "continue" };
		// Our own re-sent prompt (after compaction) and mid-run steering are not new turns.
		if (event.source === "extension" || event.streamingBehavior) return { action: "continue" };
		const text = event.text.trim();
		if (!text || text.startsWith("/")) return { action: "continue" };
		failovers = 0;

		const explicit = checkExplicitSwitch(text, cfg.roles);
		if (explicit) {
			last = {
				top: explicit,
				confidence: 1.0,
				margin: 1.0,
				probs: { [explicit]: 1.0 },
				source: "laya",
				ms: 0,
			};
		} else {
			const recent = recentUserTurns(ctx, RECENT_TURNS);
			last = await classify(ctx, cfg, text, recent);
			if (last.top && !cfg.roles[last.top]?.enabled) last = { ...last, source: "none", error: `unknown role ${last.top}` };
		}

		const prev = state.intent;
		const result = decide(state, last, cfg.thresholds, cfg.defaultRole);
		state = result.state;
		persist(pi, state);

		logDecision(cfg.logPath, {
			ts: new Date().toISOString(),
			session: ctx.sessionManager.getSessionFile?.() ?? undefined,
			turn: state.userTurns,
			text,
			probs: last.probs,
			source: last.source,
			confidence: last.confidence,
			margin: last.margin,
			layaConfidence: last.layaConfidence,
			ms: last.ms,
			error: last.error,
			prev,
			decision: result.decision.kind,
			intent: state.intent,
			model: targetModel(),
		});

		const d = result.decision;
		if (d.kind === "adopt" || d.kind === "switch") pendingNotice = d;
		showStatus(ctx);

		if (d.kind === "switch") {
			const tokens = ctx.getContextUsage()?.tokens ?? 0;
			if (isInteractive(ctx) && tokens >= cfg.thresholds.compactMinTokens) {
				compactThenResend(ctx, event.text, event.images, d.from, d.to);
				return { action: "handled" };
			}
			if (ctx.hasUI) ctx.ui.notify(`Router: ${d.from} → ${d.to} (no compaction)`, "info");
		} else if (d.kind === "hold" && ctx.hasUI) {
			ctx.ui.notify(`Router: leaning ${d.candidate} (${d.n}/${cfg.thresholds.streak}); holding ${state.intent}`, "info");
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", (event, ctx) => {
		knownSkills = (event.systemPromptOptions.skills ?? []).map((s) => s.name);
		const notice = pendingNotice ? noticeText(pendingNotice) : null;
		pendingNotice = null; // never let a stale notice surface on a later turn
		if (!isRouting(ctx)) return;
		const role = currentRole();
		const skills = availableSkills(role);
		const skillLine = skills.length
			? ` Before starting, load ${skills.length === 1 ? "the skill" : "these skills"}: ${skills.map((s) => `/skill:${s}`).join(", ")}.`
			: "";
		event.systemPromptOptions.sections.laya_router = `This conversation is routed to the **${role.name}** role (${role.id}). ${role.hint}${skillLine}`;
		if (notice) return { message: { customType: "laya-router", content: notice, display: true } };
	});

	// ---------------------------------------------------------------- command

	function rolesReport(ctx: ExtensionContext): string {
		const lines = Object.values(cfg.roles).map((role) => {
			const active = role.id === currentRole().id ? "▶ " : "  ";
			const models = role.models
				.map((m) => {
					const known = ctx.modelRegistry.find(cfg.provider.name, m) ? "" : "?";
					const at = failed.get(m);
					const down = at !== undefined && Date.now() - at < cfg.chain.retryAfterMs ? "✗" : "";
					return `${m}${known}${down}`;
				})
				.join(" → ");
			const skills = role.skills.map((s) => (knownSkills.length && !knownSkills.includes(s) ? `${s}?` : s)).join(", ");
			const off = role.enabled ? "" : " (disabled)";
			return `${active}${role.id}${off} — ${role.name}: ${role.description}\n    models: ${models}${skills ? `\n    skills: ${skills}` : ""}`;
		});
		return `${lines.join("\n")}\n(? = unknown to Pi, ✗ = failed recently)`;
	}

	pi.registerCommand("router", {
		description: "Laya router: status | on | off | force <role> | clear | roles | config | reload",
		handler: async (args, ctx) => {
			const [sub, arg] = args.trim().split(/\s+/);
			const notify = (msg: string, kind: "info" | "warning" | "error" = "info") => ctx.ui.notify(msg, kind);
			switch (sub || "status") {
				case "status": {
					const routing = ctx.model?.provider === PROVIDER;
					const lastLine = last ? ` · last: ${last.source} ${last.top} ${last.confidence.toFixed(2)} (${last.ms}ms)` : "";
					notify(
						`router ${routing ? (state.on ? "on" : "paused") : "inactive (select laya/auto)"} · intent ${state.intent ?? "none"} → ${targetModel()}` +
							`${state.forced ? " · pinned" : ""} · turn ${state.userTurns}${lastLine}`,
					);
					return;
				}
				case "on":
					state.on = true;
					persist(pi, state);
					showStatus(ctx);
					notify("router on");
					return;
				case "off":
					state.on = false;
					persist(pi, state);
					showStatus(ctx);
					notify(`router off: requests go to ${targetModel()} unchanged`);
					return;
				case "force": {
					if (!arg || !cfg.roles[arg]?.enabled) {
						notify(`usage: /router force <${roleIds().join("|")}>`, "warning");
						return;
					}
					const from = state.intent;
					state.forced = arg;
					state.intent = arg;
					state.candidate = null;
					state.lastSwitchTurn = state.userTurns;
					persist(pi, state);
					pendingNotice = from && from !== arg ? { kind: "switch", from, to: arg } : { kind: "adopt", intent: arg };
					showStatus(ctx);
					notify(`router pinned to ${arg} → ${targetModel()}`);
					return;
				}
				case "clear":
					state.forced = null;
					state.candidate = null;
					persist(pi, state);
					showStatus(ctx);
					notify("router unpinned");
					return;
				case "roles":
				case "intents":
					notify(rolesReport(ctx));
					return;
				case "config": {
					const loaded = new Set(cfg.sources);
					const files = configLayers()
						.map((f) => `  ${loaded.has(f) ? "✓" : "·"} ${f}`)
						.join("\n");
					const issues = cfg.issues.length ? `\nissues:\n${cfg.issues.map((i) => `  ${formatIssue(i)}`).join("\n")}` : "\nno issues";
					notify(
						`config layers (✓ loaded):\n${files}\nlaya ${cfg.laya.url} (${cfg.laya.model}) · fallback ${cfg.fallback.enabled ? cfg.fallback.model : "off"} · default role ${cfg.defaultRole} · log ${cfg.logPath}${issues}`,
						cfg.issues.some((i) => i.level === "error") ? "warning" : "info",
					);
					return;
				}
				case "reload": {
					cfg = loadConfig();
					failed.clear();
					issuesShown = false;
					showIssues(ctx);
					if (state.forced && !cfg.roles[state.forced]?.enabled) {
						state.forced = null;
						persist(pi, state);
					}
					showStatus(ctx);
					notify(`router config reloaded: ${roleIds().length} role(s) from ${cfg.sources.length} file(s)${cfg.issues.length ? `, ${cfg.issues.length} issue(s)` : ""}`);
					return;
				}
				default:
					notify("usage: /router [status|on|off|force <role>|clear|roles|config|reload]", "warning");
			}
		},
	});
}
