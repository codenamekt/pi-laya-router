import assert from "node:assert/strict";
import { test } from "node:test";
import { type Issue, mergeRoles, normalizeRole, parseLabel, pickModel, type Role } from "./roles.ts";

const role = (models: string[]): Role => ({ id: "r", name: "R", description: "d", models, skills: [], hint: "h", enabled: true });

test("pickModel takes the first model that has not failed recently", () => {
	const r = role(["a", "b", "c"]);
	const failed = new Map<string, number>();
	assert.deepEqual(pickModel(r, failed, 1000, 500), { model: "a", index: 0, healthy: true });
	failed.set("a", 900);
	assert.deepEqual(pickModel(r, failed, 1000, 500), { model: "b", index: 1, healthy: true });
	failed.set("b", 950);
	assert.deepEqual(pickModel(r, failed, 1000, 500), { model: "c", index: 2, healthy: true });
	// a's failure has aged out
	assert.deepEqual(pickModel(r, failed, 1500, 500), { model: "a", index: 0, healthy: true });
});

test("pickModel falls back to the least recently failed model when all are down", () => {
	const r = role(["a", "b"]);
	const failed = new Map([
		["a", 900],
		["b", 800],
	]);
	assert.deepEqual(pickModel(r, failed, 1000, 500), { model: "b", index: 1, healthy: false });
});

test("parseLabel prefers an exact match and otherwise the longest contained id", () => {
	const ids = ["ui", "ui_ux", "chat"];
	assert.equal(parseLabel("ui_ux", ids), "ui_ux");
	assert.equal(parseLabel("  UI_UX.\n", ids), "ui_ux");
	assert.equal(parseLabel("Label: ui_ux", ids), "ui_ux");
	assert.equal(parseLabel("ui", ids), "ui");
	assert.equal(parseLabel("this is chat", ids), "chat");
	assert.equal(parseLabel("nothing", ids), undefined);
});

test("normalizeRole accepts shorthand and legacy fields", () => {
	const issues: Issue[] = [];
	const r = normalizeRole("x", { models: "m", skill: "s", criteria: "c" }, issues);
	assert.deepEqual(r, { id: "x", name: "x", description: "c", models: ["m"], skills: ["s"], hint: "Take the x role: c.", enabled: true });
	assert.deepEqual(
		issues.map((i) => i.path),
		["roles.x.criteria", "roles.x.skill"],
	);
});

test("normalizeRole dedupes models and drops non-string entries with a warning", () => {
	const issues: Issue[] = [];
	const r = normalizeRole("x", { description: "d", models: ["a", 1, "a", " b "], skills: [null] }, issues);
	assert.deepEqual(r?.models, ["a", "b"]);
	assert.deepEqual(r?.skills, []);
	assert.deepEqual(
		issues.map((i) => i.path),
		["roles.x.models[1]", "roles.x.skills[0]"],
	);
});

test("mergeRoles: null removes, objects merge field by field", () => {
	const issues: Issue[] = [];
	const out = mergeRoles({ a: { description: "d", models: ["1"] }, b: { description: "e", models: ["2"] } }, { a: { models: ["3"] }, b: null, c: { description: "f" } }, "roles", issues);
	assert.deepEqual(out, { a: { description: "d", models: ["3"] }, c: { description: "f" } });
	assert.deepEqual(issues, []);
	assert.deepEqual(mergeRoles({ a: {} }, "bad", "roles", issues), { a: {} });
	assert.equal(issues[0]?.level, "error");
});
