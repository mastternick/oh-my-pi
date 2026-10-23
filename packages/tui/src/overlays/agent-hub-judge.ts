/**
 * Judge tab projection: a pure, read-only reduction of persisted judgment traces,
 * billed `model_usage` entries and auto-thinking level changes into display rows.
 * The coding-agent side supplies raw session entries; all interpretation lives here.
 *
 * Billing rule: cost and tokens come only from `model_usage`. A decision bills its direct parent usage (D.parentId === U.id,
 * same purpose/provider/model, appended earlier, not yet claimed). A proven full-cache answer made no provider call and never
 * claims a usage. Earlier retries and unclaimed judge-role usage stay separate "decision unavailable" rows. Other purposes
 * (memory, find, ttsr, ...) are excluded.
 *
 * Applied level: a `judge-effort-applied` event pairs only with the decision whose id it names. Thinking-level changes
 * without an applied event are shown as unlinked rows.
 */

export const JUDGE_TRACE_CUSTOM_TYPE = "judge-decision";
const JUDGE_TRACE_VERSION = 1;

/** Journaled after a real auto-thinking apply, including unchanged levels; pairs by exact decisionEntryId. */
export const JUDGE_EFFORT_APPLIED_CUSTOM_TYPE = "judge-effort-applied";
const JUDGE_EFFORT_APPLIED_VERSION = 1;
const JUDGE_ROLES: Record<string, true> = { judge: true, typesafe: true };
const AUTO_THINKING_PURPOSE = "auto-thinking";
const SUMMARY_MAX = 240;
const ANSWER_MAX = 120;

export type JudgeEntryInput =
	| { kind: "decision"; id: string; parentId: string | null; timestamp: number; data: unknown }
	| { kind: "applied"; id: string; parentId: string | null; timestamp: number; data: unknown }
	| {
			kind: "usage";
			id: string;
			parentId: string | null;
			timestamp: number;
			purpose: string;
			role?: string;
			provider: string;
			model: string;
			usage: unknown;
	  }
	| {
			kind: "thinking";
			id: string;
			parentId: string | null;
			timestamp: number;
			thinkingLevel?: string | null;
			configured?: string | null;
	  };

export interface JudgeSourceInput {
	/** Identity used to count a source once even when it is reachable twice. */
	key: string;
	/** Display actor: "Main" or a subagent id. */
	actor: string;
	/** Judge-relevant entries only. */
	entries: readonly JudgeEntryInput[];
}

export type JudgeOutcome = "ok" | "cache" | "error" | "unavailable";

export interface JudgeAnswerView {
	question: string;
	value: string;
	confidence?: number;
}

export interface JudgeRow {
	id: string;
	timestamp: number;
	actor: string;
	purpose: string;
	outcome: JudgeOutcome;
	provider?: string;
	model?: string;
	role?: string;
	/** Sanitized question summaries joined; empty when no trace exists. */
	summary: string;
	answers: JudgeAnswerView[];
	/** Top-level `answers.confidence` when the trace supplied one. */
	confidence?: number;
	questionCount?: number;
	cachedQuestions?: number;
	durationMs?: number;
	errorMessage?: string;
	/** Billed provider attempts attributed to this row. */
	calls: number;
	tokens: number;
	cost: number;
	/** Auto-thinking: applied level; `linked` is false when no decision could be paired. */
	thinking?: { level: string; linked: boolean };
}

export interface JudgeTotals {
	sources: number;
	decisions: number;
	ok: number;
	cache: number;
	error: number;
	unavailable: number;
	billedCalls: number;
	tokens: number;
	cost: number;
	cachedQuestions: number;
	totalQuestions: number;
	/** Usage entries from other purposes, excluded from Judge spend. */
	excludedCalls: number;
}

export interface JudgeProjection {
	rows: JudgeRow[];
	totals: JudgeTotals;
}

interface ParsedTrace {
	id: string;
	parentId: string | null;
	timestamp: number;
	purpose: string;
	provider: string;
	model: string;
	status: "ok" | "error";
	durationMs?: number;
	questions: Array<{ id: string; summary: string }>;
	answers: Record<string, unknown>;
	cachedQuestions?: number;
	totalQuestions?: number;
	errorMessage?: string;
}

interface ParsedUsage {
	id: string;
	parentId: string | null;
	timestamp: number;
	purpose: string;
	role?: string;
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
}

interface ParsedApplied {
	id: string;
	timestamp: number;
	decisionEntryId: string;
	level: string;
	thinkingEntryId?: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteOrZero(value: unknown): number {
	return finiteOrUndefined(value) ?? 0;
}

/** Strip control characters, collapse whitespace, and bound length. */
export function boundJudgeText(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const clean = value.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function formatAnswer(value: unknown): string {
	if (value === undefined) return "no answer recorded";
	if (typeof value === "string") return boundJudgeText(value, ANSWER_MAX) || "empty";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null) return "null";
	const record = recordOf(value);
	if (record) {
		for (const key of ["answer", "value", "choice"]) {
			if (record[key] !== undefined) return formatAnswer(record[key]);
		}
	}
	try {
		return boundJudgeText(JSON.stringify(value), ANSWER_MAX);
	} catch {
		return "unrenderable";
	}
}

function parseTrace(entry: Extract<JudgeEntryInput, { kind: "decision" }>): ParsedTrace | undefined {
	const data = recordOf(entry.data);
	if (!data || data.version !== JUDGE_TRACE_VERSION) return undefined;
	if (typeof data.purpose !== "string" || typeof data.provider !== "string" || typeof data.model !== "string") {
		return undefined;
	}
	if (data.status !== "ok" && data.status !== "error") return undefined;
	const questions: ParsedTrace["questions"] = [];
	if (Array.isArray(data.questions)) {
		for (const item of data.questions) {
			const question = recordOf(item);
			if (!question || typeof question.id !== "string") continue;
			questions.push({ id: question.id, summary: boundJudgeText(question.summary, SUMMARY_MAX) });
		}
	}
	return {
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		purpose: data.purpose,
		provider: data.provider,
		model: data.model,
		status: data.status,
		durationMs: finiteOrUndefined(data.durationMs),
		questions,
		answers: recordOf(data.answers) ?? {},
		cachedQuestions: finiteOrUndefined(data.cachedQuestions),
		totalQuestions: finiteOrUndefined(data.totalQuestions),
		errorMessage: typeof data.errorMessage === "string" ? boundJudgeText(data.errorMessage, SUMMARY_MAX) : undefined,
	};
}

function parseUsage(entry: Extract<JudgeEntryInput, { kind: "usage" }>): ParsedUsage {
	const usage = recordOf(entry.usage) ?? {};
	return {
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		purpose: entry.purpose,
		role: entry.role,
		provider: entry.provider,
		model: entry.model,
		inputTokens: finiteOrZero(usage.input),
		outputTokens: finiteOrZero(usage.output),
		cacheReadTokens: finiteOrZero(usage.cacheRead),
		cacheWriteTokens: finiteOrZero(usage.cacheWrite),
		cost: finiteOrZero(recordOf(usage.cost)?.total),
	};
}

function parseApplied(entry: Extract<JudgeEntryInput, { kind: "applied" }>): ParsedApplied | undefined {
	const data = recordOf(entry.data);
	if (!data || data.version !== JUDGE_EFFORT_APPLIED_VERSION) return undefined;
	const decisionEntryId = data.decisionEntryId;
	if (typeof decisionEntryId !== "string" || decisionEntryId === "") return undefined;
	const level = boundJudgeText(data.level, 32);
	if (!level) return undefined;
	const thinkingEntryId = data.thinkingEntryId;
	return {
		id: entry.id,
		timestamp: entry.timestamp,
		decisionEntryId,
		level,
		...(typeof thinkingEntryId === "string" && thinkingEntryId !== "" ? { thinkingEntryId } : {}),
	};
}

function answersFor(trace: ParsedTrace): { answers: JudgeAnswerView[]; confidence?: number } {
	const confidence = finiteOrUndefined(trace.answers.confidence);
	const views: JudgeAnswerView[] = [];
	if (trace.questions.length > 0) {
		for (const question of trace.questions) {
			const raw = trace.answers[question.id];
			const perQuestion = finiteOrUndefined(recordOf(raw)?.confidence);
			views.push({
				question: question.summary || question.id,
				value: formatAnswer(raw),
				...(perQuestion !== undefined ? { confidence: perQuestion } : {}),
			});
		}
	} else {
		for (const [key, value] of Object.entries(trace.answers)) {
			if (key === "confidence") continue;
			views.push({ question: key, value: formatAnswer(value) });
		}
	}
	return { answers: views, confidence };
}

function projectSource(source: JudgeSourceInput, rows: JudgeRow[], totals: JudgeTotals): void {
	// Physical append order is the causal order: a parent is always appended before its children.
	const traces: Array<ParsedTrace & { seq: number }> = [];
	const usages: Array<ParsedUsage & { seq: number }> = [];
	const applied: Array<ParsedApplied & { seq: number }> = [];
	const thinking: Array<Extract<JudgeEntryInput, { kind: "thinking" }>> = [];
	source.entries.forEach((entry, seq) => {
		if (entry.kind === "decision") {
			const trace = parseTrace(entry);
			if (trace) traces.push({ ...trace, seq });
		} else if (entry.kind === "usage") {
			usages.push({ ...parseUsage(entry), seq });
		} else if (entry.kind === "applied") {
			const event = parseApplied(entry);
			if (event) applied.push({ ...event, seq });
		} else {
			thinking.push(entry);
		}
	});

	// Billing: a decision bills only its direct parent usage (same purpose/provider/model, appended earlier, not yet
	// claimed). A proven full-cache answer made no provider call, so its parent is a prior call and it never claims.
	// Earlier retries stay separate "decision unavailable" rows instead of being grouped by guesswork.
	const usageById = new Map(usages.map(usage => [usage.id, usage] as const));
	const claimed = new Set<string>();
	const billByTrace = new Map<string, ParsedUsage>();
	for (const trace of traces) {
		if (isFullCache(trace) || trace.parentId === null) continue;
		const usage = usageById.get(trace.parentId);
		if (!usage || claimed.has(usage.id) || usage.seq >= trace.seq || !sameCall(usage, trace)) continue;
		claimed.add(usage.id);
		billByTrace.set(trace.id, usage);
	}

	// Applied level: pairs only with the decision it names by exact id, and only if journaled after that decision.
	// A thinking-level change named by an applied event is shown by that event, so it is not repeated.
	const tracesById = new Map(traces.map(trace => [trace.id, trace] as const));
	const levelByTrace = new Map<string, string>();
	const coveredThinking = new Set<string>();
	const orphanApplied: Array<ParsedApplied & { seq: number }> = [];
	for (const event of applied) {
		if (event.thinkingEntryId !== undefined) coveredThinking.add(event.thinkingEntryId);
		const trace = tracesById.get(event.decisionEntryId);
		if (trace && trace.seq < event.seq && !levelByTrace.has(trace.id)) levelByTrace.set(trace.id, event.level);
		else orphanApplied.push(event);
	}

	const rowId = (id: string) => `${source.key}#${id}`;
	for (const trace of traces) {
		const bill = billByTrace.get(trace.id);
		const { answers, confidence } = answersFor(trace);
		const cachedQuestions = trace.cachedQuestions ?? 0;
		const questionCount = questionCountOf(trace);
		const outcome: JudgeOutcome =
			trace.status === "error" ? "error" : isFullCache(trace) ? "cache" : "ok";
		const row: JudgeRow = {
			id: rowId(trace.id),
			timestamp: trace.timestamp,
			actor: source.actor,
			purpose: trace.purpose,
			outcome,
			provider: trace.provider,
			model: trace.model,
			summary:
				trace.questions
					.map(question => question.summary)
					.filter(Boolean)
					.join("; ") || "no question summary recorded",
			answers,
			confidence,
			questionCount,
			cachedQuestions,
			durationMs: trace.durationMs,
			errorMessage: trace.errorMessage,
			calls: bill ? 1 : 0,
			tokens: bill ? billTokens(bill) : 0,
			cost: bill?.cost ?? 0,
		};
		if (bill?.role) row.role = bill.role;
		const level = levelByTrace.get(trace.id);
		if (level !== undefined) row.thinking = { level, linked: true };
		rows.push(row);

		totals.decisions++;
		totals[outcome === "ok" ? "ok" : outcome === "cache" ? "cache" : "error"]++;
		totals.cachedQuestions += cachedQuestions;
		totals.totalQuestions += questionCount;
	}

	for (const usage of usages) {
		if (claimed.has(usage.id)) {
			addBilled(totals, usage);
			continue;
		}
		if (!usage.role || JUDGE_ROLES[usage.role] !== true) {
			totals.excludedCalls++;
			continue;
		}
		// A judge-role call with no matching trace: billed, decision unavailable.
		addBilled(totals, usage);
		totals.unavailable++;
		rows.push({
			id: rowId(usage.id),
			timestamp: usage.timestamp,
			actor: source.actor,
			purpose: usage.purpose,
			outcome: "unavailable",
			provider: usage.provider,
			model: usage.model,
			role: usage.role,
			summary: "decision unavailable (no judge trace recorded)",
			answers: [],
			calls: 1,
			tokens: billTokens(usage),
			cost: usage.cost,
		});
	}
	for (const event of orphanApplied) {
		rows.push({
			id: rowId(event.id),
			timestamp: event.timestamp,
			actor: source.actor,
			purpose: AUTO_THINKING_PURPOSE,
			outcome: "unavailable",
			summary: "decision unavailable (applied level has no matching decision)",
			answers: [],
			calls: 0,
			tokens: 0,
			cost: 0,
			thinking: { level: event.level, linked: false },
		});
	}
	for (const change of thinking) {
		const level = change.thinkingLevel;
		if (change.configured !== "auto" || !level || coveredThinking.has(change.id)) continue;
		rows.push({
			id: rowId(change.id),
			timestamp: change.timestamp,
			actor: source.actor,
			purpose: AUTO_THINKING_PURPOSE,
			outcome: "unavailable",
			summary: "decision unavailable (applied level not linked to a decision)",
			answers: [],
			calls: 0,
			tokens: 0,
			cost: 0,
			thinking: { level, linked: false },
		});
	}
}

function questionCountOf(trace: ParsedTrace): number {
	return trace.totalQuestions ?? trace.questions.length;
}

/** Every answer came from cache: no provider call was made, so the decision bills nothing. */
function isFullCache(trace: ParsedTrace): boolean {
	const cached = trace.cachedQuestions ?? 0;
	return trace.status === "ok" && cached > 0 && cached === questionCountOf(trace);
}

function sameCall(usage: ParsedUsage, trace: ParsedTrace): boolean {
	return usage.purpose === trace.purpose && usage.provider === trace.provider && usage.model === trace.model;
}

function billTokens(usage: ParsedUsage): number {
	return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function addBilled(totals: JudgeTotals, usage: ParsedUsage): void {
	totals.billedCalls++;
	totals.tokens += billTokens(usage);
	totals.cost += usage.cost;
}

/**
 * Reduce scanned sources to Judge rows. Sources must already be deduplicated by key.
 * Rows are chronological; the caller decides which end to follow.
 */
export function projectJudgeActivity(sources: readonly JudgeSourceInput[]): JudgeProjection {
	const totals: JudgeTotals = {
		sources: sources.length,
		decisions: 0,
		ok: 0,
		cache: 0,
		error: 0,
		unavailable: 0,
		billedCalls: 0,
		tokens: 0,
		cost: 0,
		cachedQuestions: 0,
		totalQuestions: 0,
		excludedCalls: 0,
	};
	const rows: JudgeRow[] = [];
	for (const source of sources) projectSource(source, rows, totals);
	rows.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
	return { rows, totals };
}

/**
 * Precise USD formatting: never collapses a positive cost to `$0.00`.
 * Costs under a cent keep enough significant digits to show the value (e.g. `$0.00002`).
 */
export function formatJudgeCost(cost: number): string {
	if (!Number.isFinite(cost)) return "—";
	if (cost === 0) return "$0";
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.01) return `$${cost.toFixed(4)}`;
	const decimals = Math.min(12, Math.ceil(-Math.log10(cost)) + 1);
	return `$${cost.toFixed(decimals)}`;
}

export function formatJudgeTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "0";
	if (tokens < 1_000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}K`;
	return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function formatJudgeClock(timestamp: number): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "--:--:--";
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export const JUDGE_OUTCOME_LABEL: Record<JudgeOutcome, string> = {
	ok: "ok",
	cache: "cache",
	error: "error",
	unavailable: "decision unavailable",
};

/** Cache reuse is a factual count; dollar savings are never estimated without a controlled baseline. */
export const JUDGE_SAVINGS_TEXT = "savings not measured (no controlled baseline)";
