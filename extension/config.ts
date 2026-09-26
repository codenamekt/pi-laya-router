/**
 * Configuration. Layers, each optional, applied in this order:
 *
 *   1. built-in defaults
 *   2. ~/.pi/agent/laya-router.json          (or the file named by LAYA_ROUTER_CONFIG)
 *   3. ~/.pi/agent/laya-router.d/*.json      (drop-ins next to the main file, sorted by name)
 *   4. <cwd>/.pi/laya-router.json            (project rules, commit them with the repo)
 *   5. <cwd>/.pi/laya-router.d/*.json
 *
 * Sections merge field by field. The first layer that defines `roles` starts
 * the set (the built-in roles apply only when no file defines any); later
 * layers merge per role, field by field, and a `null` role removes it.
 * Everything is validated once after merging: unusable roles are dropped, bad
 * values fall back to defaults, and every problem is reported through
 * `issues` (shown by `/router config`) rather than thrown.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Thresholds } from "./policy.ts";
import { DEFAULT_ROLES, enabledRoles, formatIssue, type Issue, mergeRoles, normalizeRoles, type Role } from "./roles.ts";

export type { Issue, Role } from "./roles.ts";

export interface RouterConfig {
	provider: { name: string; baseUrl: string };
	laya: { url: string; model: string; timeoutMs: number; apiKey?: string };
	fallback: { enabled: boolean; model: string; timeoutMs: number; assumedConfidence: number };
	/** compactMinTokens must exceed Pi's compaction.keepRecentTokens (20k default) or Pi reports "session too small". */
	thresholds: Thresholds & { compactMinTokens: number };
	autoModel: { contextWindow: number; maxTokens: number };
	/** Model chain behaviour: retry a failed model after this long, and whether to re-run a failed turn on the next model. */
	chain: { retryAfterMs: number; failover: boolean };
	defaultRole: string;
	logPath: string;
	roles: Record<string, Role>;
	/** Files that contributed, in order. */
	sources: string[];
	/** Everything that was wrong with the config, in load order. */
	issues: Issue[];
}

export const DEFAULTS: Omit<RouterConfig, "sources" | "issues"> = {
	provider: { name: "openai", baseUrl: "http://localhost:8787/v1" },
	laya: { url: "http://127.0.0.1:8811", model: "english", timeoutMs: 3000 },
	fallback: { enabled: true, model: "google/gemini-3.5-flash-lite", timeoutMs: 8000, assumedConfidence: 0.8 },
	thresholds: { adopt: 0.55, switch: 0.7, fast: 0.9, margin: 0.15, streak: 2, cooldownTurns: 3, compactMinTokens: 24000 },
	autoModel: { contextWindow: 200000, maxTokens: 32768 },
	chain: { retryAfterMs: 300_000, failover: true },
	defaultRole: "coding",
	logPath: "~/.pi/agent/laya-router/decisions.jsonl",
	roles: DEFAULT_ROLES,
};

const SECTIONS = ["provider", "headroom", "laya", "fallback", "thresholds", "autoModel", "chain"] as const;
const TOP_LEVEL_KEYS = new Set<string>([...SECTIONS, "$schema", "defaultRole", "defaultIntent", "logPath", "roles", "intents"]);

export function expandHome(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function configPath(): string {
	return expandHome(process.env.LAYA_ROUTER_CONFIG ?? "~/.pi/agent/laya-router.json");
}

/** All candidate files in load order, whether or not they exist. */
export function configLayers(cwd: string = process.cwd()): string[] {
	const user = configPath();
	const project = path.join(cwd, ".pi", "laya-router.json");
	return [user, ...dropIns(user), project, ...dropIns(project)];
}

function dropIns(mainFile: string): string[] {
	const dir = `${mainFile.replace(/\.json$/i, "")}.d`;
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.sort()
			.map((f) => path.join(dir, f));
	} catch {
		return [];
	}
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface Raw {
	sections: Record<(typeof SECTIONS)[number], Record<string, unknown>>;
	/** Undefined until a layer defines roles; the built-in roles apply only when none does. */
	roles?: Record<string, unknown>;
	defaultRole?: unknown;
	logPath?: unknown;
}

interface NumRule {
	min?: number;
	max?: number;
	integer?: boolean;
}

/** Typed field pickers: wrong types are reported and replaced by the default. */
function pick<T extends Record<string, unknown>>(section: string, raw: Record<string, unknown>, defaults: T, issues: Issue[], rules: Partial<Record<keyof T, NumRule>> = {}): T {
	const out = { ...defaults } as Record<string, unknown>;
	for (const [key, value] of Object.entries(raw)) {
		const def = defaults[key];
		const p = `${section}.${key}`;
		if (def === undefined && !(section === "laya" && key === "apiKey")) {
			issues.push({ level: "warning", path: p, message: "unknown field; ignored" });
			continue;
		}
		const expected = def === undefined ? "string" : typeof def;
		if (typeof value !== expected) {
			issues.push({ level: "warning", path: p, message: `expected a ${expected}; using default ${JSON.stringify(def)}` });
			continue;
		}
		if (typeof value === "number") {
			const rule = rules[key as keyof T] ?? {};
			const bad =
				Number.isNaN(value) ||
				(rule.integer && !Number.isInteger(value)) ||
				(rule.min !== undefined && value < rule.min) ||
				(rule.max !== undefined && value > rule.max);
			if (bad) {
				const range = [rule.integer ? "integer" : "", rule.min !== undefined ? `>= ${rule.min}` : "", rule.max !== undefined ? `<= ${rule.max}` : ""].filter(Boolean).join(" ");
				issues.push({ level: "warning", path: p, message: `expected ${range}; using default ${def}` });
				continue;
			}
		} else if (typeof value === "string" && !value.trim()) {
			issues.push({ level: "warning", path: p, message: `expected a non-empty string; using default ${JSON.stringify(def)}` });
			continue;
		}
		out[key] = value;
	}
	return out as T;
}

/** Merge raw layers into a validated config. Exported so tests can feed it objects directly. */
export function buildConfig(layers: Array<{ file: string; data: unknown }>): RouterConfig {
	const issues: Issue[] = [];
	const sources: string[] = [];
	const acc: Raw = {
		sections: { provider: {}, headroom: {}, laya: {}, fallback: {}, thresholds: {}, autoModel: {}, chain: {} },
	};
	for (const { file, data } of layers) {
		applyLayer(acc, file, data, issues, sources);
	}
	return finish(acc, issues, sources);
}

/** Merge one parsed layer onto `acc`, reporting anything it cannot use. */
function applyLayer(acc: Raw, file: string, data: unknown, issues: Issue[], sources: string[]): void {
	if (!isObject(data)) {
		issues.push({ level: "error", path: file, message: "expected a JSON object; skipped" });
		return;
	}
	sources.push(file);
	const at = (key: string) => `${path.basename(file)}: ${key}`;
	for (const key of Object.keys(data)) {
		if (!TOP_LEVEL_KEYS.has(key)) issues.push({ level: "warning", path: at(key), message: "unknown field; ignored" });
	}
	for (const section of SECTIONS) {
		const value = data[section];
		if (value === undefined) continue;
		if (isObject(value)) acc.sections[section] = { ...acc.sections[section], ...value };
		else issues.push({ level: "warning", path: at(section), message: "expected an object; ignored" });
	}
	if (data.intents !== undefined) {
		issues.push({ level: "warning", path: at("intents"), message: "deprecated; rename to `roles`" });
		acc.roles = mergeRoles(acc.roles ?? {}, data.intents, at("intents"), issues);
	}
	if (data.roles !== undefined) acc.roles = mergeRoles(acc.roles ?? {}, data.roles, at("roles"), issues);
	if (data.defaultIntent !== undefined) {
		issues.push({ level: "warning", path: at("defaultIntent"), message: "deprecated; rename to `defaultRole`" });
		acc.defaultRole = data.defaultIntent;
	}
	if (data.defaultRole !== undefined) acc.defaultRole = data.defaultRole;
	if (data.logPath !== undefined) acc.logPath = data.logPath;
}

function finish(acc: Raw, issues: Issue[], sources: string[]): RouterConfig {
	const unit = { min: 0, max: 1 };
	const thresholds = pick("thresholds", acc.sections.thresholds, DEFAULTS.thresholds, issues, {
		adopt: unit,
		switch: unit,
		fast: unit,
		margin: unit,
		streak: { min: 1, integer: true },
		cooldownTurns: { min: 0, integer: true },
		compactMinTokens: { min: 0, integer: true },
	});
	const laya = pick("laya", acc.sections.laya, DEFAULTS.laya, issues, { timeoutMs: { min: 1, integer: true } });
	const fallback = pick("fallback", acc.sections.fallback, DEFAULTS.fallback, issues, { timeoutMs: { min: 1, integer: true }, assumedConfidence: unit });
	const autoModel = pick("autoModel", acc.sections.autoModel, DEFAULTS.autoModel, issues, { contextWindow: { min: 1, integer: true }, maxTokens: { min: 1, integer: true } });
	const chain = pick("chain", acc.sections.chain, DEFAULTS.chain, issues, { retryAfterMs: { min: 0, integer: true } });
	// Legacy `headroom: { provider, baseUrl }` maps onto `provider: { name, baseUrl }`; an explicit provider block wins.
	let rawProvider: Record<string, unknown> = acc.sections.provider;
	const legacy = acc.sections.headroom;
	if (Object.keys(legacy).length > 0) {
		issues.push({ level: "warning", path: "headroom", message: "deprecated; rename to `provider` with `name` and `baseUrl`" });
		rawProvider = {
			...(typeof legacy.provider === "string" ? { name: legacy.provider } : {}),
			...(typeof legacy.baseUrl === "string" ? { baseUrl: legacy.baseUrl } : {}),
			...rawProvider,
		};
	}
	const provider = normalizeProvider(pick("provider", rawProvider, DEFAULTS.provider, issues), issues);

	let roles = acc.roles ? normalizeRoles(acc.roles, issues) : { ...DEFAULTS.roles };
	if (Object.keys(enabledRoles(roles)).length === 0) {
		issues.push({ level: "error", path: "roles", message: "no usable enabled role; using the built-in roles" });
		roles = { ...DEFAULTS.roles };
	}

	let defaultRole = DEFAULTS.defaultRole;
	if (acc.defaultRole !== undefined) {
		if (typeof acc.defaultRole === "string") defaultRole = acc.defaultRole;
		else issues.push({ level: "warning", path: "defaultRole", message: "expected a role id" });
	}
	if (!roles[defaultRole]?.enabled) {
		const first = Object.keys(enabledRoles(roles))[0];
		issues.push({ level: "warning", path: "defaultRole", message: `"${defaultRole}" is not an enabled role; using "${first}"` });
		defaultRole = first;
	}

	let logPath = DEFAULTS.logPath;
	if (acc.logPath !== undefined) {
		if (typeof acc.logPath === "string" && acc.logPath.trim()) logPath = acc.logPath;
		else issues.push({ level: "warning", path: "logPath", message: "expected a non-empty string; using default" });
	}

	return { provider, laya, fallback, thresholds, autoModel, chain, defaultRole, logPath, roles, sources, issues };
}

function normalizeProvider(raw: unknown, issues: Issue[]): { name: string; baseUrl: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		issues.push({ level: "warning", path: "provider", message: "expected object, using default" });
		return DEFAULTS.provider;
	}
	const obj = raw as Record<string, unknown>;
	const name = typeof obj.name === "string" ? obj.name : (typeof obj.provider === "string" ? obj.provider : DEFAULTS.provider.name);
	const baseUrl = typeof obj.baseUrl === "string" ? obj.baseUrl : DEFAULTS.provider.baseUrl;
	return { name, baseUrl };
}

export function loadConfig(cwd: string = process.cwd()): RouterConfig {
	const layers: Array<{ file: string; data: unknown }> = [];
	const readIssues: Issue[] = [];
	for (const file of configLayers(cwd)) {
		try {
			if (!fs.existsSync(file)) continue;
			layers.push({ file, data: JSON.parse(fs.readFileSync(file, "utf8")) });
		} catch (err) {
			readIssues.push({ level: "error", path: file, message: `could not read: ${err instanceof Error ? err.message : err}; skipped` });
		}
	}
	const cfg = buildConfig(layers);
	cfg.issues.unshift(...readIssues);
	for (const issue of cfg.issues) console.warn(`laya-router: ${formatIssue(issue)}`);
	return cfg;
}

/** Same lookup as provider auth: env var, then config files. */
export function providerApiKey(): string {
	if (process.env.PROVIDER_API_KEY) return process.env.PROVIDER_API_KEY;
	if (process.env.HEADROOM_API_KEY) return process.env.HEADROOM_API_KEY;
	try {
		const envFile = path.join(os.homedir(), ".config", "headroom", "env");
		if (fs.existsSync(envFile)) {
			const content = fs.readFileSync(envFile, "utf8");
			const match =
				content.match(/^PROVIDER_API_KEY=(.+)$/m) ||
				content.match(/^HEADROOM_API_KEY=(.+)$/m) ||
				content.match(/^LITELLM_MASTER_KEY=(.+)$/m);
			if (match) return match[1].trim().replace(/^["']|["']$/g, "");
		}
	} catch {
		// fall through
	}
	return "";
}
