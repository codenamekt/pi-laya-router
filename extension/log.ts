/**
 * Append-only JSONL decision log. This is the future fine-tuning set, so it
 * stores the (truncated) prompt in plain text. Keep it local.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { expandHome } from "./config.ts";

const TEXT_CHARS = 2000;

export interface DecisionRecord {
	ts: string;
	session?: string;
	turn: number;
	text: string;
	probs: Record<string, number>;
	source: "laya" | "llm" | "none";
	confidence: number;
	margin: number;
	layaConfidence?: number;
	ms: number;
	error?: string;
	prev: string | null;
	decision: string;
	intent: string | null;
	model: string | null;
}

export function logDecision(logPath: string, rec: DecisionRecord): void {
	try {
		const file = expandHome(logPath);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify({ ...rec, text: rec.text.slice(0, TEXT_CHARS) })}\n`, "utf8");
	} catch (err) {
		console.warn(`laya-router: could not write log: ${err instanceof Error ? err.message : err}`);
	}
}
