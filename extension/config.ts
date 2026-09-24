/**
 * Configuration: defaults merged with ~/.pi/agent/laya-router.json
 * (or the file named by LAYA_ROUTER_CONFIG).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Thresholds } from "./policy.ts";

export interface IntentConfig {
	/** Model id as known to the headroom provider (what LiteLLM receives). */
	model: string;
	/** Skill name to suggest (informational; /skill:<name> if it exists). */
	skill?: string;
	/** One-paragraph guidance appended to the system prompt while this intent is active. */
	hint: string;
	/** Laya choice criteria and LLM fallback description. Keep short and mutually exclusive. */
	criteria: string;
}

export interface RouterConfig {
	headroom: { provider: string; baseUrl: string };
	laya: { url: string; model: string; timeoutMs: number; apiKey?: string };
	fallback: { enabled: boolean; model: string; timeoutMs: number; assumedConfidence: number };
	/** compactMinTokens must exceed Pi's compaction.keepRecentTokens (20k default) or Pi reports "session too small". */
	thresholds: Thresholds & { compactMinTokens: number };
	autoModel: { contextWindow: number; maxTokens: number };
	defaultIntent: string;
	logPath: string;
	intents: Record<string, IntentConfig>;
}

export const DEFAULTS: RouterConfig = {
	headroom: { provider: "headroom", baseUrl: "http://localhost:8787/v1" },
	laya: { url: "http://127.0.0.1:8811", model: "english", timeoutMs: 3000 },
	fallback: { enabled: true, model: "google/gemini-3.5-flash-lite", timeoutMs: 8000, assumedConfidence: 0.8 },
	thresholds: { adopt: 0.55, switch: 0.7, fast: 0.9, margin: 0.15, streak: 2, cooldownTurns: 3, compactMinTokens: 24000 },
	autoModel: { contextWindow: 200000, maxTokens: 32768 },
	defaultIntent: "coding",
	logPath: "~/.pi/agent/laya-router/decisions.jsonl",
	intents: {
		coding: {
			model: "google/gemini-3.7-flash",
			skill: "coder",
			hint: "Act as an implementer: make focused, correct code changes, read before editing, and verify with tests or a dry run.",
			criteria: "write, edit, fix or refactor code; implement a change; make tests pass; run commands to get code working",
		},
		planning: {
			model: "minimax/minimax-m3",
			skill: "planner",
			hint: "Act as a planner: understand the problem deeply, explore the codebase, weigh trade-offs, and produce a numbered plan before touching code.",
			criteria: "design, architecture, trade-offs, step-by-step plans, research or investigation before building, deciding an approach",
		},
		ui_ux: {
			model: "google/gemini-3.7-flash",
			skill: "designer",
			hint: "Act as a UI/UX implementer: care about layout, spacing, states, accessibility and copy; check the result visually when possible.",
			criteria: "layout, styling, visual design, components, colors, copy, accessibility, front-end look and feel",
		},
		chat: {
			model: "google/gemini-3.5-flash-lite",
			hint: "Answer directly and briefly; no tools unless needed.",
			criteria: "questions, explanations, small utility tasks, casual conversation",
		},
	},
};

export function expandHome(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function configPath(): string {
	return expandHome(process.env.LAYA_ROUTER_CONFIG ?? "~/.pi/agent/laya-router.json");
}

export function loadConfig(): RouterConfig {
	let user: Partial<RouterConfig> = {};
	try {
		const file = configPath();
		if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		console.warn(`laya-router: could not read config: ${err instanceof Error ? err.message : err}`);
	}
	const cfg: RouterConfig = {
		headroom: { ...DEFAULTS.headroom, ...user.headroom },
		laya: { ...DEFAULTS.laya, ...user.laya },
		fallback: { ...DEFAULTS.fallback, ...user.fallback },
		thresholds: { ...DEFAULTS.thresholds, ...user.thresholds },
		autoModel: { ...DEFAULTS.autoModel, ...user.autoModel },
		defaultIntent: user.defaultIntent ?? DEFAULTS.defaultIntent,
		logPath: user.logPath ?? DEFAULTS.logPath,
		// A user-supplied intents block replaces the defaults entirely.
		intents: user.intents ?? DEFAULTS.intents,
	};
	if (!cfg.intents[cfg.defaultIntent]) {
		console.warn(`laya-router: defaultIntent "${cfg.defaultIntent}" is not a configured intent; using first`);
		cfg.defaultIntent = Object.keys(cfg.intents)[0];
	}
	return cfg;
}

/** Same lookup as the headroom provider extension: env var, then ~/.config/headroom/env. */
export function headroomApiKey(): string {
	if (process.env.HEADROOM_API_KEY) return process.env.HEADROOM_API_KEY;
	try {
		const envFile = path.join(os.homedir(), ".config", "headroom", "env");
		if (fs.existsSync(envFile)) {
			const content = fs.readFileSync(envFile, "utf8");
			const match =
				content.match(/^HEADROOM_API_KEY=(.+)$/m) ||
				content.match(/^LITELLM_MASTER_KEY=(.+)$/m) ||
				content.match(/^HEADROOM_INTERNAL_TOKEN=(.+)$/m);
			if (match) return match[1].trim().replace(/^["']|["']$/g, "");
		}
	} catch {
		// fall through
	}
	return "";
}
