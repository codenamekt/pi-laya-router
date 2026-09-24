/**
 * Router state persistence. State lives in the session as `custom` entries so
 * it follows the branch on resume, fork and /tree navigation.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { freshState, type RouterState } from "./policy.ts";

export const ENTRY_TYPE = "laya-router";

export function persist(pi: ExtensionAPI, state: RouterState): void {
	pi.appendEntry(ENTRY_TYPE, state);
}

/** Last persisted state on the current branch, or a fresh one. */
export function restore(ctx: ExtensionContext): RouterState {
	let found: RouterState | undefined;
	for (const entry of ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) {
			found = entry.data as RouterState;
		}
	}
	return found ? { ...freshState(), ...found } : freshState();
}

/** Recent user prompts on the branch, oldest first, for classifier context. */
export function recentUserTurns(ctx: ExtensionContext, limit: number): string[] {
	const out: string[] = [];
	for (const entry of ctx.sessionManager.getBranch() as Array<{ type: string; message?: { role?: string; content?: unknown } }>) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
							.map((c) => c.text)
							.join(" ")
					: "";
		if (text.trim()) out.push(text.trim());
	}
	return out.slice(-limit);
}
