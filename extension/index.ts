/**
 * Laya intent router for Pi.
 *
 * Registers a `laya` provider with one model, `auto`. While `laya/auto`
 * is selected, every user turn is classified (Laya locally, cheap LLM as
 * fallback), a hysteresis policy decides whether the kind of work changed,
 * and the outgoing request's `model` is rewritten to the intent's target.
 * On a switch the session is compacted with instructions about the move,
 * and the model gets a short hint naming the suggested skill.
 *
 * Usage: pi -e /path/to/pi-laya-router/extension   then   /model laya/auto
 */
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { classify, type ClassifyResult } from "./classifier.ts";
import { configPath, headroomApiKey, loadConfig, type RouterConfig } from "./config.ts";
import { logDecision } from "./log.ts";
import { type Decision, decide, freshState, type RouterState } from "./policy.ts";
import { persist, recentUserTurns, restore } from "./state.ts";

const PROVIDER = "laya";
const MODEL_ID = "auto";
const RECENT_TURNS = 2;
const COMPACT_SLOW_MS = 60_000;

export default function (pi: ExtensionAPI) {
	const cfg: RouterConfig = loadConfig();
	let state: RouterState = freshState();
	/** Set when a run should announce an adopt/switch to the model. */
	let pendingNotice: Decision | null = null;
	let last: ClassifyResult | null = null;

	// ---------------------------------------------------------------- helpers

	/** laya/auto is the selected model: always rewrite the upstream model. */
	const isDelegating = (ctx: ExtensionContext) => ctx.model?.provider === PROVIDER;
	/** ...and classification is not paused via /router off. */
	const isRouting = (ctx: ExtensionContext) => state.on && isDelegating(ctx);
	/** Compact-then-resend is asynchronous; print/json mode awaits a single prompt and would lose it. */
	const isInteractive = (ctx: ExtensionContext) => ctx.mode === "tui" || ctx.mode === "rpc";
	const intentOf = (name: string | null) => (name && cfg.intents[name]) || cfg.intents[cfg.defaultIntent];
	const targetModel = () => intentOf(state.intent).model;
	const shortModel = (id: string) => id.split("/").pop() ?? id;

	function showStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!state.on || ctx.model?.provider !== PROVIDER) {
			ctx.ui.setStatus("router", undefined);
			return;
		}
		const intent = state.intent ?? cfg.defaultIntent;
		const pending = state.candidate ? ` (${state.candidate.intent} ${state.candidate.n}/${cfg.thresholds.streak})` : "";
		const forced = state.forced ? " pinned" : "";
		ctx.ui.setStatus("router", `⇄ ${intent}${forced} · ${shortModel(targetModel())}${pending}`);
	}

	function noticeText(d: Decision): string | null {
		if (d.kind === "adopt") {
			const i = intentOf(d.intent);
			return `Laya router: intent **${d.intent}** → \`${i.model}\`${i.skill ? ` · suggested skill: /skill:${i.skill}` : ""}`;
		}
		if (d.kind === "switch") {
			const i = intentOf(d.to);
			return `Laya router: **${d.from} → ${d.to}**, now serving with \`${i.model}\`${i.skill ? ` · suggested skill: /skill:${i.skill}` : ""}`;
		}
		return null;
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
	function compactThenResend(ctx: ExtensionContext, text: string, images: unknown[] | undefined, from: string, to: string) {
		const resend = () => {
			const content = images?.length ? [{ type: "text" as const, text }, ...(images as never[])] : text;
			pi.sendUserMessage(content as never, { expandPromptTemplates: false });
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
		baseUrl: cfg.headroom.baseUrl,
		apiKey: headroomApiKey(),
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
		return { ...payload, model: targetModel() };
	});

	// Pi's built-in summarizer calls the provider directly, bypassing the payload
	// hook above, so it would send model "auto" upstream. While delegating, we
	// generate the summary ourselves with the real target model.
	pi.on("session_before_compact", async (event, ctx) => {
		if (!isDelegating(ctx)) return;
		const { preparation, customInstructions, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;
		const model =
			ctx.modelRegistry.find(cfg.headroom.provider, targetModel()) ??
			ctx.modelRegistry.find(cfg.headroom.provider, cfg.fallback.model);
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify(`Router: no summarizer model found under ${cfg.headroom.provider}; compaction cancelled`, "warning");
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
	pi.on("session_start", onRestore);
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

		const recent = recentUserTurns(ctx, RECENT_TURNS);
		last = await classify(ctx, cfg, text, recent);
		if (last.top && !cfg.intents[last.top]) last = { ...last, source: "none", error: `unknown intent ${last.top}` };

		const prev = state.intent;
		const result = decide(state, last, cfg.thresholds, cfg.defaultIntent);
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
		const notice = pendingNotice ? noticeText(pendingNotice) : null;
		pendingNotice = null; // never let a stale notice surface on a later turn
		if (!isRouting(ctx)) return;
		const intentName = state.intent ?? cfg.defaultIntent;
		const intent = intentOf(intentName);
		const skill = intent.skill ? ` If a \`${intent.skill}\` skill is available, load it with /skill:${intent.skill}.` : "";
		const section = `\n\n## Router mode\nThis conversation is classified as **${intentName}**. ${intent.hint}${skill}`;

		return {
			systemPrompt: `${event.systemPrompt}${section}`,
			...(notice ? { message: { customType: "laya-router", content: notice, display: true } } : {}),
		};
	});

	// ---------------------------------------------------------------- command

	pi.registerCommand("router", {
		description: "Laya router: status | on | off | force <intent> | clear | intents | config",
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
					if (!arg || !cfg.intents[arg]) {
						notify(`usage: /router force <${Object.keys(cfg.intents).join("|")}>`, "warning");
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
				case "intents":
					notify(
						Object.entries(cfg.intents)
							.map(([k, v]) => `${k} → ${v.model}${v.skill ? ` (skill ${v.skill})` : ""}`)
							.join("\n"),
					);
					return;
				case "config":
					notify(`config ${configPath()} · laya ${cfg.laya.url} (${cfg.laya.model}) · fallback ${cfg.fallback.enabled ? cfg.fallback.model : "off"} · log ${cfg.logPath}`);
					return;
				default:
					notify("usage: /router [status|on|off|force <intent>|clear|intents|config]", "warning");
			}
		},
	});
}
