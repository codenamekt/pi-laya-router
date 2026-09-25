/**
 * Roles: what the router routes *to*. A role has a name, a short description
 * (which doubles as the classifier's criteria), a model chain tried in order,
 * and the skills the model should lean on while the role is active.
 *
 * Pure module: no Pi imports, no I/O. Raw config objects come in, validated
 * roles and a list of issues come out.
 */

export interface Role {
	/** Config key. This is the classifier label and what `/router force` takes. */
	id: string;
	/** Display name. Defaults to the id. */
	name: string;
	/** What requests belong here. Sent to Laya as the choice criteria and to the LLM fallback as the label text. */
	description: string;
	/** Model ids in preference order, as the headroom provider knows them. */
	models: string[];
	/** Skill names to suggest while the role is active (only those Pi actually has get mentioned). */
	skills: string[];
	/** Guidance appended to the system prompt while the role is active. */
	hint: string;
	/** Disabled roles stay in the config but are never classified against or routed to. */
	enabled: boolean;
}

export interface Issue {
	level: "error" | "warning";
	/** Config path, e.g. `roles.coder.models`. */
	path: string;
	message: string;
}

export const ROLE_ID = /^[a-z][a-z0-9_-]*$/;

const ROLE_KEYS = new Set(["name", "description", "criteria", "models", "model", "skills", "skill", "hint", "enabled"]);

export const DEFAULT_ROLES: Record<string, Role> = {
	coding: {
		id: "coding",
		name: "Coder",
		description: "write, edit, fix or refactor code; implement a change; make tests pass; run commands to get code working",
		models: ["google/gemini-3.7-flash", "minimax/minimax-m3"],
		skills: ["coder"],
		hint: "Act as an implementer: make focused, correct code changes, read before editing, and verify with tests or a dry run.",
		enabled: true,
	},
	planning: {
		id: "planning",
		name: "Planner",
		description: "design, architecture, trade-offs, step-by-step plans, research or investigation before building, deciding an approach",
		models: ["minimax/minimax-m3", "google/gemini-3.7-flash"],
		skills: ["planner"],
		hint: "Act as a planner: understand the problem deeply, explore the codebase, weigh trade-offs, and produce a numbered plan before touching code.",
		enabled: true,
	},
	ui_ux: {
		id: "ui_ux",
		name: "Designer",
		description: "layout, styling, visual design, components, colors, copy, accessibility, front-end look and feel",
		models: ["google/gemini-3.7-flash"],
		skills: ["designer"],
		hint: "Act as a UI/UX implementer: care about layout, spacing, states, accessibility and copy; check the result visually when possible.",
		enabled: true,
	},
	chat: {
		id: "chat",
		name: "Chat",
		description: "questions, explanations, small utility tasks, casual conversation",
		models: ["google/gemini-3.5-flash-lite", "google/gemini-3.7-flash"],
		skills: [],
		hint: "Answer directly and briefly; no tools unless needed.",
		enabled: true,
	},
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Accepts a string or an array of strings; anything else is reported and dropped. */
function stringList(value: unknown, path: string, issues: Issue[]): string[] {
	if (value === undefined || value === null) return [];
	const items = Array.isArray(value) ? value : [value];
	const out: string[] = [];
	for (const [i, item] of items.entries()) {
		if (typeof item === "string" && item.trim()) {
			const s = item.trim();
			if (!out.includes(s)) out.push(s);
		} else issues.push({ level: "warning", path: `${path}[${i}]`, message: "expected a non-empty string; ignored" });
	}
	return out;
}

/**
 * Validate one raw role. Returns undefined (and an error issue) when the role
 * is unusable. Legacy intent fields (`model`, `skill`, `criteria`) are accepted.
 */
export function normalizeRole(id: string, raw: unknown, issues: Issue[]): Role | undefined {
	const path = `roles.${id}`;
	if (!ROLE_ID.test(id)) {
		issues.push({ level: "error", path, message: `role id must match ${ROLE_ID} (lowercase, digits, _ or -); dropped` });
		return undefined;
	}
	if (!isObject(raw)) {
		issues.push({ level: "error", path, message: "expected an object; dropped" });
		return undefined;
	}
	for (const key of Object.keys(raw)) {
		if (!ROLE_KEYS.has(key)) issues.push({ level: "warning", path: `${path}.${key}`, message: "unknown field; ignored" });
	}
	if (raw.criteria !== undefined && raw.description === undefined) {
		issues.push({ level: "warning", path: `${path}.criteria`, message: "deprecated; rename to `description`" });
	}
	if (raw.model !== undefined && raw.models === undefined) {
		issues.push({ level: "warning", path: `${path}.model`, message: "deprecated; use `models: [..]`" });
	}
	if (raw.skill !== undefined && raw.skills === undefined) {
		issues.push({ level: "warning", path: `${path}.skill`, message: "deprecated; use `skills: [..]`" });
	}

	const description = raw.description ?? raw.criteria;
	if (typeof description !== "string" || !description.trim()) {
		issues.push({ level: "error", path: `${path}.description`, message: "required: a short description of the requests that belong to this role; dropped" });
		return undefined;
	}
	const models = stringList(raw.models ?? raw.model, `${path}.models`, issues);
	if (models.length === 0) {
		issues.push({ level: "error", path: `${path}.models`, message: "required: at least one model id; dropped" });
		return undefined;
	}
	const skills = stringList(raw.skills ?? raw.skill, `${path}.skills`, issues);

	let name = id;
	if (raw.name !== undefined) {
		if (typeof raw.name === "string" && raw.name.trim()) name = raw.name.trim();
		else issues.push({ level: "warning", path: `${path}.name`, message: "expected a non-empty string; using the id" });
	}
	let hint = `Take the ${name} role: ${description.trim()}.`;
	if (raw.hint !== undefined) {
		if (typeof raw.hint === "string" && raw.hint.trim()) hint = raw.hint.trim();
		else issues.push({ level: "warning", path: `${path}.hint`, message: "expected a non-empty string; using a generated hint" });
	}
	let enabled = true;
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") enabled = raw.enabled;
		else issues.push({ level: "warning", path: `${path}.enabled`, message: "expected true or false; assuming true" });
	}
	return { id, name, description: description.trim(), models, skills, hint, enabled };
}

/**
 * Layer a raw `roles` block onto another. Per role: `null` removes it, an object
 * is merged field by field (so a layer can override just `models`), anything
 * else replaces. Returns raw objects; validate with `normalizeRoles` at the end.
 */
export function mergeRoles(base: Record<string, unknown>, patch: unknown, path: string, issues: Issue[]): Record<string, unknown> {
	if (patch === undefined) return base;
	if (!isObject(patch)) {
		issues.push({ level: "error", path, message: "expected an object keyed by role id; ignored" });
		return base;
	}
	const out: Record<string, unknown> = { ...base };
	for (const [id, value] of Object.entries(patch)) {
		if (value === null) delete out[id];
		else if (isObject(value) && isObject(out[id])) out[id] = { ...out[id], ...value };
		else out[id] = value;
	}
	return out;
}

export function normalizeRoles(raw: Record<string, unknown>, issues: Issue[]): Record<string, Role> {
	const roles: Record<string, Role> = {};
	for (const [id, value] of Object.entries(raw)) {
		const role = normalizeRole(id, value, issues);
		if (role) roles[id] = role;
	}
	return roles;
}

/** Roles the classifier may choose between. */
export function enabledRoles(roles: Record<string, Role>): Record<string, Role> {
	return Object.fromEntries(Object.entries(roles).filter(([, r]) => r.enabled));
}

export interface Pick {
	model: string;
	index: number;
	/** False when every model in the chain failed within the retry window and this is the least recent failure. */
	healthy: boolean;
}

/**
 * Pick the model to send for a role: the first in its chain that has not
 * failed within `retryAfterMs`. When every model has failed, take the one
 * that failed longest ago. `failed` maps model id to the failure timestamp.
 */
export function pickModel(role: Role, failed: ReadonlyMap<string, number>, now: number, retryAfterMs: number): Pick {
	let oldest: { model: string; index: number; at: number } | undefined;
	for (const [index, model] of role.models.entries()) {
		const at = failed.get(model);
		if (at === undefined || now - at >= retryAfterMs) return { model, index, healthy: true };
		if (!oldest || at < oldest.at) oldest = { model, index, at };
	}
	return oldest ? { model: oldest.model, index: oldest.index, healthy: false } : { model: role.models[0], index: 0, healthy: true };
}

/**
 * Map free-form classifier output back to a role id: exact match first, then
 * the longest id that appears in the text, so `ui` and `ui_ux` can coexist.
 */
export function parseLabel(output: string, ids: string[]): string | undefined {
	const text = output.trim().toLowerCase();
	const bare = text.replace(/^[^a-z0-9]+|[^a-z0-9_-]+$/g, "");
	if (ids.includes(bare)) return bare;
	// Match id only when not embedded in a longer alphanumeric/underscore/hyphen token
	const hits = ids.filter((id) => new RegExp(`(?<![a-z0-9_-])${id.toLowerCase()}(?![a-z0-9_-])`).test(text)).sort((a, b) => b.length - a.length);
	return hits[0];
}

export function formatIssue(i: Issue): string {
	return `${i.level}: ${i.path}: ${i.message}`;
}
