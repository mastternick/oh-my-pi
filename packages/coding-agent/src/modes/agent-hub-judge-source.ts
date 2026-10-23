import * as fs from "node:fs";
import * as path from "node:path";
import type { JudgeActivitySource } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import {
	JUDGE_EFFORT_APPLIED_CUSTOM_TYPE,
	JUDGE_TRACE_CUSTOM_TYPE,
	type JudgeEntryInput,
	type JudgeSourceInput,
} from "@oh-my-pi/pi-tui/overlays/agent-hub-judge";
import type { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { type AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { sessionFileBelongsToRoot } from "../registry/persisted-agents";
import type { SessionEntry } from "../session/session-entries";
import { visitEntriesFromFileStream } from "../session/session-loader";
import type { SessionManager } from "../session/session-manager";

interface Collector {
	entries: JudgeEntryInput[];
}

interface CachedFile {
	actor: string;
	mtimeMs: number;
	size: number;
	source: JudgeSourceInput;
}

function timestampOf(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Keep the Judge-relevant entries (decision traces, applied-effort events, billed usage, thinking-level changes) in append order. */
function collectEntry(entry: SessionEntry, out: Collector): void {
	const { id, parentId } = entry;
	const timestamp = timestampOf(entry.timestamp);
	if (entry.type === "custom") {
		if (entry.customType === JUDGE_TRACE_CUSTOM_TYPE) {
			out.entries.push({ kind: "decision", id, parentId, timestamp, data: entry.data });
		} else if (entry.customType === JUDGE_EFFORT_APPLIED_CUSTOM_TYPE) {
			out.entries.push({ kind: "applied", id, parentId, timestamp, data: entry.data });
		}
	} else if (entry.type === "model_usage") {
		out.entries.push({
			kind: "usage",
			id,
			parentId,
			timestamp,
			purpose: entry.purpose,
			role: entry.role,
			provider: entry.provider,
			model: entry.model,
			usage: entry.usage,
		});
	} else if (entry.type === "thinking_level_change") {
		out.entries.push({
			kind: "thinking",
			id,
			parentId,
			timestamp,
			thinkingLevel: entry.thinkingLevel,
			configured: entry.configured,
		});
	}
}

/**
 * Parse one persisted transcript. A missing file yields `undefined` so the caller can
 * fall back to live memory; any other filesystem error propagates to the hub's warn path.
 */
async function readFileSource(
	file: string,
	actor: string,
	cache: Map<string, CachedFile>,
): Promise<JudgeSourceInput | undefined> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const hit = cache.get(file);
	if (hit && hit.actor === actor && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.source;
	const out: Collector = { entries: [] };
	await visitEntriesFromFileStream(file, entry => {
		if (entry.type !== "session") collectEntry(entry, out);
	});
	const source: JudgeSourceInput = { key: file, actor, entries: out.entries };
	cache.set(file, { actor, mtimeMs: stat.mtimeMs, size: stat.size, source });
	return source;
}

function memorySource(key: string, actor: string, sessionManager: SessionManager): JudgeSourceInput {
	const out: Collector = { entries: [] };
	for (const entry of sessionManager.getEntries()) collectEntry(entry, out);
	return { key, actor, entries: out.entries };
}

/**
 * Judge decisions for the main session plus its subagent descendants. Scope mirrors
 * `sumSubagentTreeCost`: transcripts count only inside the root's artifacts tree and
 * file-less agents count only while this session's observer tracks them. Each transcript
 * is read once per (path, actor) and re-read only when its mtime or size changes.
 */
export function createJudgeActivitySource(options: {
	registry: AgentRegistry;
	observers: SessionObserverRegistry;
	sessionManager: SessionManager;
}): JudgeActivitySource {
	const cache = new Map<string, CachedFile>();
	return {
		async load(): Promise<readonly JudgeSourceInput[]> {
			const { registry, observers, sessionManager } = options;
			const rootFile = sessionManager.getSessionFile() ?? null;
			const rootKey = rootFile ? path.resolve(rootFile) : "memory:main";
			const sources: JudgeSourceInput[] = [memorySource(rootKey, MAIN_AGENT_ID, sessionManager)];
			const seen = new Set<string>([rootKey]);
			for (const ref of registry.list()) {
				if (ref.id === MAIN_AGENT_ID) continue;
				if (ref.sessionFile) {
					if (!rootFile || !sessionFileBelongsToRoot(ref.sessionFile, rootFile)) continue;
					const key = path.resolve(ref.sessionFile);
					if (seen.has(key)) continue;
					seen.add(key);
					const source = await readFileSource(key, ref.id, cache);
					if (source) {
						sources.push(source);
						continue;
					}
				}
				if (!ref.session || !observers.getSession(ref.id)) continue;
				const key = `memory:${ref.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				sources.push(memorySource(key, ref.id, ref.session.sessionManager));
			}
			return sources;
		},
	};
}
