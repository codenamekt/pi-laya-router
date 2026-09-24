/**
 * Intent classification: Laya first, cheap LLM fallback second.
 */
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RouterConfig } from "./config.ts";
import type { Classification } from "./policy.ts";

export interface ClassifyResult extends Classification {
	probs: Record<string, number>;
	ms: number;
	/** Laya's own calibrated confidence, when available. */
	layaConfidence?: number;
	error?: string;
}

// The English Laya checkpoint has a 512 token budget for state + question.
const PROMPT_CHARS = 1200;
const RECENT_CHARS = 300;

function trunc(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

function topTwo(probs: Record<string, number>): { top: string; confidence: number; margin: number } {
	const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]);
	const [top, p1] = sorted[0] ?? ["", 0];
	const p2 = sorted[1]?.[1] ?? 0;
	return { top, confidence: p1, margin: p1 - p2 };
}

export async function classifyWithLaya(cfg: RouterConfig, text: string, recent: string[]): Promise<ClassifyResult> {
	const started = Date.now();
	const criteria = Object.fromEntries(Object.entries(cfg.intents).map(([k, v]) => [k, v.criteria]));
	const body = {
		model: cfg.laya.model,
		state: {
			request: trunc(text, PROMPT_CHARS),
			previous: trunc(recent.join(" | "), RECENT_CHARS),
		},
		questions: {
			intent: {
				type: "choice",
				instructions: "What kind of work is the user asking the coding agent to do right now?",
				criteria,
			},
		},
	};
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cfg.laya.apiKey) headers.authorization = `Bearer ${cfg.laya.apiKey}`;

	const res = await fetch(`${cfg.laya.url}/v1/systemone`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(cfg.laya.timeoutMs),
	});
	if (!res.ok) throw new Error(`laya ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const data = (await res.json()) as {
		answers?: { intent?: { choice?: string; probabilities?: Record<string, number>; confidence?: number } };
	};
	const ans = data.answers?.intent;
	if (!ans?.probabilities) throw new Error("laya: no probabilities in answer");
	return { ...topTwo(ans.probabilities), probs: ans.probabilities, layaConfidence: ans.confidence, source: "laya", ms: Date.now() - started };
}

export async function classifyWithLlm(
	ctx: ExtensionContext,
	cfg: RouterConfig,
	text: string,
	recent: string[],
): Promise<ClassifyResult> {
	const started = Date.now();
	const model = ctx.modelRegistry.find(cfg.headroom.provider, cfg.fallback.model);
	if (!model) throw new Error(`fallback model ${cfg.headroom.provider}/${cfg.fallback.model} not found`);

	const labels = Object.entries(cfg.intents)
		.map(([k, v]) => `- ${k}: ${v.criteria}`)
		.join("\n");
	const prompt = `Classify the user's latest request to a coding agent into exactly one label.

Labels:
${labels}

Previous requests (context only): ${trunc(recent.join(" | "), RECENT_CHARS) || "none"}

Latest request:
"""
${trunc(text, PROMPT_CHARS)}
"""

Reply with only the label name.`;

	const response = await ctx.modelRegistry.complete(
		model,
		{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
		{ maxTokens: 32, cacheRetention: "none", sessionId: uuidv7(), signal: AbortSignal.timeout(cfg.fallback.timeoutMs) },
	);
	const out = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join(" ")
		.toLowerCase();
	const label = Object.keys(cfg.intents).find((k) => out.includes(k.toLowerCase()));
	if (!label) throw new Error(`fallback returned no label: ${out.slice(0, 80)}`);
	const probs = Object.fromEntries(Object.keys(cfg.intents).map((k) => [k, k === label ? cfg.fallback.assumedConfidence : 0]));
	return { top: label, confidence: cfg.fallback.assumedConfidence, margin: 1, probs, source: "llm", ms: Date.now() - started };
}

/**
 * Laya, then the LLM fallback when Laya is unreachable or not confident enough.
 * Never throws: returns source "none" when nothing usable came back.
 */
export async function classify(ctx: ExtensionContext, cfg: RouterConfig, text: string, recent: string[]): Promise<ClassifyResult> {
	let laya: ClassifyResult | undefined;
	let error: string | undefined;
	try {
		laya = await classifyWithLaya(cfg, text, recent);
		const confident = laya.confidence >= cfg.thresholds.adopt && laya.margin >= cfg.thresholds.margin;
		if (confident || !cfg.fallback.enabled) return laya;
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}
	if (cfg.fallback.enabled) {
		try {
			const llm = await classifyWithLlm(ctx, cfg, text, recent);
			return { ...llm, error, probs: laya ? { ...laya.probs } : llm.probs };
		} catch (err) {
			error = `${error ? `${error}; ` : ""}${err instanceof Error ? err.message : String(err)}`;
		}
	}
	if (laya) return { ...laya, error };
	return { top: "", confidence: 0, margin: 0, probs: {}, source: "none", ms: 0, error };
}
