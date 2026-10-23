/**
 * Stall guard: a progress tracker for subagent runs, in two stages.
 *
 * Stage 1 (suspicion, deterministic): a run that keeps issuing requests without
 * edits, new commands, or a yield past a counter threshold is handed to the
 * caller as a `suspect` decision with an evidence snapshot. The caller asks a
 * judge and reports the answer through {@link StallGuard.resolveSuspicion}.
 * Stage 2 (verdict): `looping` or `blocked` earns one steering notice; the next
 * suspicion after the grace period, if judged looping or blocked again, stops
 * the run through the forced-final-report path. `progressing`, an unavailable
 * judge, or a low-confidence answer takes no action, and the next suspicion
 * needs the counters to double. Counters alone never stop a run.
 *
 * Sequencing: a request's tool results arrive after its assistant `message_end`
 * and before the next one, so a request is closed when the next request starts.
 * Strong progress (and weak progress in read-only runs) resets the window as its
 * tool result arrives, so a judgment still in flight cannot notice or stop a run
 * that has moved.
 */

export type StallVerdict = "progressing" | "looping" | "blocked";

export interface StallLimits {
	/** Auto-compactions since the last strong progress. */
	readonly compactions: number;
	/** Repeated no-progress calls since the last strong progress. */
	readonly repeats: number;
	/** Output tokens since the last strong progress. */
	readonly outputTokens: number;
	/** Assistant requests since the last strong progress. */
	readonly requests: number;
}

export interface StallThresholds {
	/** Any single counter reaching its limit asks the judge. Counters never stop a run by themselves. */
	readonly suspicion: StallLimits;
}

export const STALL_THRESHOLDS: StallThresholds = {
	suspicion: { compactions: 4, repeats: 8, outputTokens: 300_000, requests: 40 },
};

export type StallProgress = "strong" | "weak" | "none";

export interface StallEvidence {
	readonly requests: number;
	readonly compactions: number;
	readonly repeats: number;
	readonly outputTokens: number;
	/** Most recent tool-call lines, oldest first, each flagged REPEAT or new. */
	readonly calls: readonly string[];
	/** The last two assistant texts are the same after normalization. */
	readonly restatesBlocker: boolean;
}

export type StallDecision =
	| { readonly kind: "ok" }
	| { readonly kind: "suspect"; readonly token: number; readonly evidence: StallEvidence; readonly signal: AbortSignal }
	| { readonly kind: "notice"; readonly requests: number; readonly compactions: number; readonly blocked: boolean }
	| { readonly kind: "stop"; readonly requests: number; readonly compactions: number; readonly reason: string };

/** Tools whose successful call is always progress. */
const STRONG_TOOLS: Record<string, true> = {
	yield: true,
	edit: true,
	write: true,
	ast_edit: true,
	apply_patch: true,
	task: true,
};
/** Shell-like tools: a new command is weak progress; a repeated one is strong only when its output changed. */
const SHELL_TOOLS: Record<string, true> = { bash: true, eval: true };
/** Internal URLs hold session state, not work product: writing to them is not progress. */
const INTERNAL_URL = /^(agent|proc|xd|artifact):\/\//;
/** Argument keys that do not change what a call does. */
const COSMETIC_ARG_KEYS: Record<string, true> = {
	intent: true,
	i: true,
	timeout: true,
	description: true,
	label: true,
	reason: true,
	title: true,
};

/** Recent tool-call lines kept as judge evidence. */
const EVIDENCE_CALLS = 25;
/** Assistant texts are compared on their first characters after normalization. */
const EVIDENCE_TEXT_CHARS = 300;

export function stallFingerprint(name: string, args: unknown): string {
	const kept: Record<string, unknown> = {};
	if (args && typeof args === "object" && !Array.isArray(args)) {
		const source = args as Record<string, unknown>;
		for (const key of Object.keys(source).sort()) {
			if (COSMETIC_ARG_KEYS[key] !== true) kept[key] = source[key];
		}
	}
	return `${name}\0${JSON.stringify(kept)}`;
}

/** Metadata that changes between identical runs: elapsed time, never output content. */
const VOLATILE_KEYS: Record<string, true> = { wallTimeMs: true, durationMs: true, startedAt: true, endedAt: true };

/** Digest of a tool result with clock-like, duration, and timing-metadata noise removed. */
export function stallOutputDigest(result: unknown): number {
	const text = (JSON.stringify(result, (key, value) => (VOLATILE_KEYS[key] ? undefined : value)) ?? "")
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "")
		.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|secs?|seconds?|mins?|minutes?)\b/gi, "");
	return Number(Bun.hash(text));
}

/** One-line description of a call for the judge: name, path with selector, or command head. */
function describeCall(name: string, args: unknown): string {
	const source = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const parts = [name];
	if (typeof source.path === "string") {
		const selector =
			source.offset !== undefined || source.limit !== undefined
				? `:${String(source.offset ?? "")}+${String(source.limit ?? "")}`
				: "";
		parts.push(`${source.path}${selector}`);
	}
	if (typeof source.command === "string") parts.push(source.command.replace(/\s+/g, " ").slice(0, 80));
	return parts.join(" ");
}

export function stallStopReason(requests: number, compactions: number, verdict?: "looping" | "blocked"): string {
	const detail = `no progress for ${requests} requests / ${compactions} compactions`;
	return verdict
		? `Stalled (stall guard, judge: ${verdict}): ${detail}`
		: `Stalled: ${detail} (stall guard)`;
}

export interface StallToolResult {
	readonly name: string;
	readonly args: unknown;
	readonly isError: boolean;
	readonly result: unknown;
}

export interface StallGuard {
	/** Record one finished tool call of the request currently in flight. */
	recordToolResult(call: StallToolResult): void;
	/** Record a successful auto-compaction. */
	recordCompaction(): void;
	/** Record the text of an assistant turn (empty when the turn had no text). */
	recordAssistantText(text: string): void;
	/**
	 * Close the previous request (its tool results are now known) and open the
	 * next one with its output-token count. Returns the decision for the window
	 * after the closed request.
	 */
	startRequest(outputTokens: number): StallDecision;
	/**
	 * Apply the judge's answer to the suspicion identified by `token`. `undefined`
	 * means the judge was unavailable, failed, canceled, or low-confidence. Answers
	 * for a window that has since reset are ignored.
	 */
	resolveSuspicion(token: number, verdict: StallVerdict | undefined): StallDecision;
	/** An async result was injected into the context: any suspicion or judgment in flight is stale. */
	recordAsyncResult(): void;
}

/** After a notice, the stop waits for this many progress-free requests or compactions. */
const NOTICE_GRACE_REQUESTS = 3;
const NOTICE_GRACE_COMPACTIONS = 1;

type Window = { requests: number; compactions: number; outputTokens: number; repeats: number };

const emptyWindow = (): Window => ({ requests: 0, compactions: 0, outputTokens: 0, repeats: 0 });

const normalizeText = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, EVIDENCE_TEXT_CHARS);

export function createStallGuard(options: { readOnly: boolean; thresholds?: StallThresholds }): StallGuard {
	const thresholds = options.thresholds ?? STALL_THRESHOLDS;
	// Fingerprint -> last output digest (0 for non-shell tools). Keys are dynamic.
	const seen = new Map<string, number>();
	// Failed-call fingerprint -> result digest of its last failure. Failures stay no progress, but an identical failure repeats.
	const failed = new Map<string, number>();
	const calls: string[] = [];
	let texts: string[] = [];
	let window = emptyWindow();
	// Bumped on every window reset (strong progress, or weak progress in read-only runs), so a late answer for an old window is ignored.
	let epoch = 0;
	// Doubles after each non-looping suspicion; reset whenever progress resets the window (strong, or weak in a read-only run).
	let scale = 1;
	// The suspicion awaiting its judge. Single-flight: no new suspicion until its answer settles, even when canceled.
	let judging: { token: number; controller: AbortController } | undefined;
	let noticed = false;
	// Progress-free requests and compactions since the notice; the stop waits for these.
	let afterNotice = { requests: 0, compactions: 0 };
	let openOutputTokens: number | undefined;
	let inFlight: StallProgress = "none";

	const rank: Record<StallProgress, number> = { none: 0, weak: 1, strong: 2 };

	const classify = (call: StallToolResult): { progress: StallProgress; repeat: boolean } => {
		if (call.isError) {
			// Failures are no progress; an identical failure with the same result is a repeat.
			const failure = stallFingerprint(call.name, call.args);
			const digest = stallOutputDigest(call.result);
			const repeat = failed.get(failure) === digest;
			failed.set(failure, digest);
			return { progress: "none", repeat };
		}
		const path = (call.args as { path?: unknown } | undefined)?.path;
		const internal = typeof path === "string" && INTERNAL_URL.test(path);
		if (STRONG_TOOLS[call.name] === true && !internal) return { progress: "strong", repeat: false };
		const fingerprint = stallFingerprint(call.name, call.args);
		const isShell = SHELL_TOOLS[call.name] === true;
		const digest = isShell ? stallOutputDigest(call.result) : 0;
		const previous = seen.get(fingerprint);
		seen.set(fingerprint, digest);
		if (previous === undefined) return { progress: "weak", repeat: false };
		if (isShell && digest !== previous) return { progress: "strong", repeat: false };
		return { progress: "none", repeat: true };
	};

	const suspicionTripped = (w: Window): boolean => {
		const s = thresholds.suspicion;
		return (
			w.compactions >= s.compactions * scale ||
			w.repeats >= s.repeats * scale ||
			w.outputTokens >= s.outputTokens * scale ||
			w.requests >= s.requests * scale
		);
	};

	const graceDone = (): boolean =>
		!noticed || afterNotice.requests >= NOTICE_GRACE_REQUESTS || afterNotice.compactions >= NOTICE_GRACE_COMPACTIONS;

	const evidence = (): StallEvidence => ({
		requests: window.requests,
		compactions: window.compactions,
		repeats: window.repeats,
		outputTokens: window.outputTokens,
		calls: [...calls],
		restatesBlocker: texts.length === 2 && texts[0] !== "" && texts[0] === texts[1],
	});

	const noticeOrStop = (verdict?: "looping" | "blocked"): StallDecision => {
		if (!noticed) {
			noticed = true;
			afterNotice = { requests: 0, compactions: 0 };
			return { kind: "notice", requests: window.requests, compactions: window.compactions, blocked: verdict === "blocked" };
		}
		if (!graceDone()) return { kind: "ok" };
		return {
			kind: "stop",
			requests: window.requests,
			compactions: window.compactions,
			reason: stallStopReason(window.requests, window.compactions, verdict),
		};
	};

	// Stales the window's answer and cancels its judge. The judgment stays single-flight until its answer settles.
	const invalidateJudgment = (): void => {
		epoch += 1;
		judging?.controller.abort();
	};

	const resetWindow = (): void => {
		window = emptyWindow();
		noticed = false;
		afterNotice = { requests: 0, compactions: 0 };
		scale = 1;
		invalidateJudgment();
	};

	const closeRequest = (progress: StallProgress, outputTokens: number): StallDecision => {
		if (progress === "strong" || (progress === "weak" && options.readOnly)) {
			resetWindow();
			return { kind: "ok" };
		}
		window.requests += 1;
		window.outputTokens += outputTokens;
		if (noticed) afterNotice.requests += 1;
		if (judging || !graceDone() || !suspicionTripped(window)) return { kind: "ok" };
		const controller = new AbortController();
		judging = { token: epoch, controller };
		return { kind: "suspect", token: epoch, evidence: evidence(), signal: controller.signal };
	};

	return {
		recordToolResult(call) {
			const { progress, repeat } = classify(call);
			// Progress takes effect as its tool result arrives: a judgment in flight must not notice or stop a run that moved.
			if (progress === "strong" || (progress === "weak" && options.readOnly)) resetWindow();
			// A new result stales a judgment in flight, so the next request boundary judges current evidence; a repeat keeps it.
			else if (!repeat) invalidateJudgment();
			if (repeat) window.repeats += 1;
			if (rank[progress] > rank[inFlight]) inFlight = progress;
			const flags = `${repeat ? "REPEAT" : "new"}${call.isError ? ", error" : ""}`;
			calls.push(`${describeCall(call.name, call.args)} [${flags}]`);
			if (calls.length > EVIDENCE_CALLS) calls.shift();
		},
		recordCompaction() {
			window.compactions += 1;
			if (noticed) afterNotice.compactions += 1;
		},
		recordAssistantText(text) {
			texts.push(normalizeText(text));
			if (texts.length > 2) texts = texts.slice(-2);
		},
		startRequest(outputTokens) {
			const decision = openOutputTokens === undefined ? { kind: "ok" as const } : closeRequest(inFlight, openOutputTokens);
			openOutputTokens = outputTokens;
			inFlight = "none";
			return decision;
		},
		resolveSuspicion(token, verdict) {
			if (judging?.token !== token) return { kind: "ok" };
			judging = undefined;
			// Progress since the suspicion made the answer stale: its window no longer exists.
			if (token !== epoch) return { kind: "ok" };
			if (verdict === undefined || verdict === "progressing") {
				scale *= 2;
				return { kind: "ok" };
			}
			return noticeOrStop(verdict);
		},
		recordAsyncResult() {
			invalidateJudgment();
		},
	};
}
