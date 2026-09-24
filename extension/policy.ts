/**
 * Pure routing policy. No Pi imports, no I/O, so it can be unit tested with
 * `node --test extension/policy.test.ts`.
 *
 * The policy answers one question per user turn: given the current router
 * state and a fresh classification, do we keep the current intent, start
 * building evidence for a new one, or switch now?
 */

export interface Thresholds {
	/** Minimum confidence to adopt an intent on the very first turn. */
	adopt: number;
	/** Minimum confidence for a turn to count as evidence for a switch. */
	switch: number;
	/** Confidence at which a single turn is enough to switch (subject to cooldown). */
	fast: number;
	/** Minimum gap between the top two probabilities for a turn to count. */
	margin: number;
	/** Consecutive qualifying turns required before switching. */
	streak: number;
	/** Minimum user turns between two switches. */
	cooldownTurns: number;
}

export interface RouterState {
	/** Routing is active (laya/auto selected and not paused via /router off). */
	on: boolean;
	/** Current intent, or null before the first classification. */
	intent: string | null;
	/** Evidence for a pending switch. */
	candidate: { intent: string; n: number } | null;
	/** Count of user turns seen while routing. */
	userTurns: number;
	/** userTurns value at the last switch (0 = never). */
	lastSwitchTurn: number;
	/** Intent pinned via `/router force`, or null. */
	forced: string | null;
}

export interface Classification {
	top: string;
	confidence: number;
	margin: number;
	source: "laya" | "llm" | "none";
}

export type Decision =
	| { kind: "none"; reason: string }
	| { kind: "adopt"; intent: string }
	| { kind: "hold"; candidate: string; n: number; need: number }
	| { kind: "switch"; from: string; to: string };

export function freshState(): RouterState {
	return { on: true, intent: null, candidate: null, userTurns: 0, lastSwitchTurn: 0, forced: null };
}

/**
 * Apply one user turn. Returns the next state and the decision taken.
 * `defaultIntent` is used when no evidence is available on the first turn.
 */
export function decide(
	prev: RouterState,
	c: Classification,
	th: Thresholds,
	defaultIntent: string,
): { state: RouterState; decision: Decision } {
	const state: RouterState = { ...prev, userTurns: prev.userTurns + 1 };

	// A forced intent short-circuits classification entirely.
	if (state.forced) {
		if (state.intent === state.forced) return { state, decision: { kind: "none", reason: "forced" } };
		const from = state.intent;
		state.intent = state.forced;
		state.candidate = null;
		state.lastSwitchTurn = state.userTurns;
		return {
			state,
			decision: from ? { kind: "switch", from, to: state.forced } : { kind: "adopt", intent: state.forced },
		};
	}

	// First turn: adopt whatever we have, or the default.
	if (state.intent === null) {
		const usable = c.source !== "none" && c.confidence >= th.adopt;
		state.intent = usable ? c.top : defaultIntent;
		state.lastSwitchTurn = state.userTurns;
		return { state, decision: { kind: "adopt", intent: state.intent } };
	}

	// No usable signal: keep everything as is.
	if (c.source === "none") return { state, decision: { kind: "none", reason: "no-signal" } };

	// Same intent as current: clear any pending evidence.
	if (c.top === state.intent) {
		state.candidate = null;
		return { state, decision: { kind: "none", reason: "same" } };
	}

	// Weak or ambiguous signal for a different intent: ignore, drop evidence.
	if (c.confidence < th.switch || c.margin < th.margin) {
		state.candidate = null;
		return { state, decision: { kind: "none", reason: "weak" } };
	}

	// Accumulate evidence for the new intent.
	const n = state.candidate?.intent === c.top ? state.candidate.n + 1 : 1;
	state.candidate = { intent: c.top, n };

	const enough = n >= th.streak || c.confidence >= th.fast;
	const cooled = state.userTurns - state.lastSwitchTurn >= th.cooldownTurns;
	if (!enough || !cooled) {
		const need = enough ? th.cooldownTurns - (state.userTurns - state.lastSwitchTurn) : th.streak - n;
		return { state, decision: { kind: "hold", candidate: c.top, n, need: Math.max(need, 1) } };
	}

	const from = state.intent;
	state.intent = c.top;
	state.candidate = null;
	state.lastSwitchTurn = state.userTurns;
	return { state, decision: { kind: "switch", from, to: c.top } };
}
