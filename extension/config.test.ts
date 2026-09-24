import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULTS } from "./config.ts";

test("laya-router.example.json matches the code defaults", () => {
	const example = JSON.parse(readFileSync(new URL("../laya-router.example.json", import.meta.url), "utf8"));
	assert.deepEqual(example, DEFAULTS);
});

test("intent names are not substrings of one another (fallback label parsing relies on it)", () => {
	const names = Object.keys(DEFAULTS.intents);
	for (const a of names) for (const b of names) if (a !== b) assert.ok(!a.includes(b), `${a} contains ${b}`);
});
