import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildConfig, DEFAULTS, loadConfig } from "./config.ts";

const example = () => JSON.parse(readFileSync(new URL("../laya-router.example.json", import.meta.url), "utf8"));
const errors = (cfg: { issues: { level: string }[] }) => cfg.issues.filter((i) => i.level === "error");

test("laya-router.example.json matches the code defaults and loads cleanly", () => {
	const cfg = buildConfig([{ file: "example.json", data: example() }]);
	assert.deepEqual(cfg.issues, []);
	const { sources: _s, issues: _i, ...rest } = cfg;
	assert.deepEqual(rest, DEFAULTS);
});

test("no config at all yields the built-in roles", () => {
	const cfg = buildConfig([]);
	assert.deepEqual(cfg.issues, []);
	assert.deepEqual(Object.keys(cfg.roles), Object.keys(DEFAULTS.roles));
	assert.equal(cfg.defaultRole, "coding");
});

test("the first layer with roles replaces the built-ins; later layers merge per role", () => {
	const cfg = buildConfig([
		{
			file: "user.json",
			data: { roles: { coder: { description: "code", models: ["a"] }, chat: { description: "talk", models: ["b"] } } },
		},
		{
			file: "team.json",
			data: { roles: { coder: { models: ["c", "a"], skills: ["tdd"] }, reviewer: { name: "Reviewer", description: "review diffs", models: "d" } } },
		},
		{ file: "project.json", data: { roles: { chat: null }, defaultRole: "reviewer" } },
	]);
	assert.deepEqual(cfg.issues, []);
	assert.deepEqual(Object.keys(cfg.roles).sort(), ["coder", "reviewer"]);
	assert.deepEqual(cfg.roles.coder.models, ["c", "a"]);
	assert.deepEqual(cfg.roles.coder.skills, ["tdd"]);
	assert.equal(cfg.roles.coder.description, "code");
	assert.deepEqual(cfg.roles.reviewer.models, ["d"]);
	assert.equal(cfg.roles.reviewer.hint, "Take the Reviewer role: review diffs.");
	assert.equal(cfg.defaultRole, "reviewer");
	assert.deepEqual(cfg.sources, ["user.json", "team.json", "project.json"]);
});

test("legacy intents/model/skill/criteria/defaultIntent still work, with deprecation warnings", () => {
	const cfg = buildConfig([
		{
			file: "old.json",
			data: {
				defaultIntent: "coding",
				intents: {
					coding: { model: "m1", skill: "coder", hint: "h", criteria: "write code" },
					chat: { model: "m2", hint: "h", criteria: "talk" },
				},
			},
		},
	]);
	assert.deepEqual(errors(cfg), []);
	assert.deepEqual(Object.keys(cfg.roles), ["coding", "chat"]);
	assert.deepEqual(cfg.roles.coding, { id: "coding", name: "coding", description: "write code", models: ["m1"], skills: ["coder"], hint: "h", enabled: true });
	assert.equal(cfg.defaultRole, "coding");
	const paths = cfg.issues.map((i) => i.path);
	assert.ok(paths.includes("old.json: intents"));
	assert.ok(paths.includes("old.json: defaultIntent"));
	assert.ok(paths.includes("roles.coding.model"));
	assert.ok(paths.includes("roles.coding.criteria"));
});

test("unusable roles are dropped with an error and the rest survive", () => {
	const cfg = buildConfig([
		{
			file: "x.json",
			data: {
				roles: {
					ok: { description: "fine", models: ["m"] },
					"Bad Id": { description: "x", models: ["m"] },
					nomodels: { description: "x", models: [] },
					nodesc: { models: ["m"] },
					notobj: "nope",
					typo: { description: "x", models: ["m"], modle: "m" },
				},
			},
		},
	]);
	assert.deepEqual(Object.keys(cfg.roles).sort(), ["ok", "typo"]);
	assert.deepEqual(
		errors(cfg).map((i) => i.path).sort(),
		["roles.Bad Id", "roles.nodesc.description", "roles.nomodels.models", "roles.notobj"],
	);
	assert.ok(cfg.issues.some((i) => i.path === "roles.typo.modle" && i.level === "warning"));
});

test("with no usable role the built-ins come back", () => {
	const cfg = buildConfig([{ file: "x.json", data: { roles: { only: { description: "x", models: ["m"], enabled: false } } } }]);
	assert.ok(errors(cfg).some((i) => i.path === "roles"));
	assert.deepEqual(Object.keys(cfg.roles), Object.keys(DEFAULTS.roles));
});

test("defaultRole must be an enabled role", () => {
	const cfg = buildConfig([
		{ file: "x.json", data: { defaultRole: "chat", roles: { chat: { description: "talk", models: ["x"], enabled: false }, coder: { description: "code", models: ["x"] } } } },
	]);
	assert.equal(cfg.defaultRole, "coder");
	assert.ok(cfg.issues.some((i) => i.path === "defaultRole"));
});

test("bad scalar values fall back to defaults with a warning; unknown keys warn", () => {
	const cfg = buildConfig([
		{
			file: "x.json",
			data: {
				thresholds: { adopt: 1.5, streak: 0, cooldownTurns: 2.5, margin: "no", compactMinTokens: 100 },
				laya: { timeoutMs: -1, apiKey: "k", bogus: 1 },
				chain: { retryAfterMs: 10, failover: "yes" },
				headroom: "not-an-object",
				extra: true,
				logPath: "",
			},
		},
	]);
	assert.equal(cfg.thresholds.adopt, DEFAULTS.thresholds.adopt);
	assert.equal(cfg.thresholds.streak, DEFAULTS.thresholds.streak);
	assert.equal(cfg.thresholds.cooldownTurns, DEFAULTS.thresholds.cooldownTurns);
	assert.equal(cfg.thresholds.margin, DEFAULTS.thresholds.margin);
	assert.equal(cfg.thresholds.compactMinTokens, 100);
	assert.equal(cfg.laya.timeoutMs, DEFAULTS.laya.timeoutMs);
	assert.equal(cfg.laya.apiKey, "k");
	assert.equal(cfg.chain.retryAfterMs, 10);
	assert.equal(cfg.chain.failover, true);
	assert.deepEqual(cfg.headroom, DEFAULTS.headroom);
	assert.equal(cfg.logPath, DEFAULTS.logPath);
	const paths = cfg.issues.map((i) => i.path);
	for (const p of ["thresholds.adopt", "thresholds.streak", "thresholds.cooldownTurns", "thresholds.margin", "laya.timeoutMs", "laya.bogus", "chain.failover", "x.json: headroom", "x.json: extra", "logPath"]) {
		assert.ok(paths.includes(p), `expected an issue at ${p}, got ${paths.join(", ")}`);
	}
	assert.deepEqual(errors(cfg), []);
});

test("a non-object layer is skipped with an error", () => {
	const cfg = buildConfig([{ file: "list.json", data: [1, 2] }]);
	assert.deepEqual(cfg.sources, []);
	assert.equal(errors(cfg)[0]?.path, "list.json");
});

test("loadConfig reads the user file, its drop-in dir, and the project layer in order", () => {
	const home = mkdtempSync(join(tmpdir(), "laya-router-cfg-"));
	const cwd = mkdtempSync(join(tmpdir(), "laya-router-proj-"));
	const user = join(home, "laya-router.json");
	writeFileSync(user, JSON.stringify({ roles: { coder: { description: "code", models: ["u"] } } }));
	mkdirSync(join(home, "laya-router.d"));
	writeFileSync(join(home, "laya-router.d", "10-team.json"), JSON.stringify({ roles: { coder: { models: ["t"] }, docs: { description: "docs", models: ["d"] } } }));
	writeFileSync(join(home, "laya-router.d", "00-first.json"), JSON.stringify({ roles: { coder: { models: ["f"] } } }));
	writeFileSync(join(home, "laya-router.d", "broken.json"), "{ nope");
	writeFileSync(join(home, "laya-router.d", "README.md"), "ignored");
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "laya-router.json"), JSON.stringify({ defaultRole: "docs", thresholds: { streak: 1 } }));

	const prev = process.env.LAYA_ROUTER_CONFIG;
	process.env.LAYA_ROUTER_CONFIG = user;
	const warn = console.warn;
	console.warn = () => {};
	try {
		const cfg = loadConfig(cwd);
		assert.deepEqual(cfg.sources, [user, join(home, "laya-router.d", "00-first.json"), join(home, "laya-router.d", "10-team.json"), join(cwd, ".pi", "laya-router.json")]);
		assert.deepEqual(cfg.roles.coder.models, ["t"]);
		assert.equal(cfg.defaultRole, "docs");
		assert.equal(cfg.thresholds.streak, 1);
		assert.equal(errors(cfg).length, 1);
		assert.match(errors(cfg)[0].path, /broken\.json$/);
	} finally {
		console.warn = warn;
		if (prev === undefined) delete process.env.LAYA_ROUTER_CONFIG;
		else process.env.LAYA_ROUTER_CONFIG = prev;
	}
});

test("a legacy headroom section maps onto provider with a deprecation warning", () => {
	const cfg = buildConfig([{ file: "old.json", data: { headroom: { provider: "headroom", baseUrl: "http://nuc:8787/v1" } } }]);
	assert.deepEqual(cfg.provider, { name: "headroom", baseUrl: "http://nuc:8787/v1" });
	assert.ok(cfg.issues.some((i) => i.path === "headroom" && i.level === "warning"));
	assert.deepEqual(errors(cfg), []);
	const both = buildConfig([{ file: "x.json", data: { headroom: { provider: "old" }, provider: { name: "new" } } }]);
	assert.equal(both.provider.name, "new");
});

