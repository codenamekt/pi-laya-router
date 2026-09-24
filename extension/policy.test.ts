import assert from "node:assert/strict";
import { test } from "node:test";
import { type Classification, decide, freshState, type Thresholds } from "./policy.ts";

const th: Thresholds = { adopt: 0.55, switch: 0.7, fast: 0.9, margin: 0.15, streak: 2, cooldownTurns: 3 };
const c = (top: string, confidence = 0.8, margin = 0.4, source: Classification["source"] = "laya"): Classification => ({
	top,
	confidence,
	margin,
	source,
});

test("first turn adopts the classified intent when confident", () => {
	const r = decide(freshState(), c("planning"), th, "coding");
	assert.equal(r.decision.kind, "adopt");
	assert.equal(r.state.intent, "planning");
});

test("first turn falls back to the default when unsure", () => {
	const r = decide(freshState(), c("planning", 0.4), th, "coding");
	assert.equal(r.state.intent, "coding");
});

test("same intent clears pending evidence", () => {
	let s = decide(freshState(), c("coding"), th, "coding").state;
	s = decide(s, c("planning"), th, "coding").state;
	assert.equal(s.candidate?.n, 1);
	s = decide(s, c("coding"), th, "coding").state;
	assert.equal(s.candidate, null);
});

test("switch needs a streak and the cooldown", () => {
	const s = decide(freshState(), c("coding"), th, "coding").state; // turn 1, lastSwitch=1
	let r = decide(s, c("planning"), th, "coding"); // turn 2: n=1
	assert.equal(r.decision.kind, "hold");
	r = decide(r.state, c("planning"), th, "coding"); // turn 3: n=2 but gap=2 < 3
	assert.equal(r.decision.kind, "hold");
	r = decide(r.state, c("planning"), th, "coding"); // turn 4: gap=3 -> switch
	assert.equal(r.decision.kind, "switch");
	assert.equal(r.state.intent, "planning");
	assert.equal(r.state.lastSwitchTurn, 4);
});

test("a single very confident turn switches once cooled", () => {
	let s = freshState();
	s = decide(s, c("coding"), th, "coding").state; // 1
	s = decide(s, c("coding"), th, "coding").state; // 2
	s = decide(s, c("coding"), th, "coding").state; // 3
	const r = decide(s, c("ui_ux", 0.95, 0.9), th, "coding"); // 4
	assert.equal(r.decision.kind, "switch");
});

test("weak or ambiguous turns never accumulate", () => {
	let s = decide(freshState(), c("coding"), th, "coding").state;
	for (let i = 0; i < 5; i++) s = decide(s, c("planning", 0.65), th, "coding").state;
	assert.equal(s.intent, "coding");
	assert.equal(s.candidate, null);
	for (let i = 0; i < 5; i++) s = decide(s, c("planning", 0.9, 0.05), th, "coding").state;
	assert.equal(s.intent, "coding");
});

test("no signal keeps state", () => {
	const s = decide(freshState(), c("coding"), th, "coding").state;
	const r = decide(s, c("planning", 0, 0, "none"), th, "coding");
	assert.equal(r.decision.kind, "none");
	assert.equal(r.state.intent, "coding");
});

test("forced intent wins immediately", () => {
	const s = decide(freshState(), c("coding"), th, "coding").state;
	s.forced = "planning";
	const r = decide(s, c("coding"), th, "coding");
	assert.equal(r.decision.kind, "switch");
	assert.equal(r.state.intent, "planning");
});
