/**
 * Verified cross-agent experience: lesson capture and recall for the mnemopi
 * backend.
 *
 * Capture runs only at settled checkpoints. A lesson is admitted only when it
 * cites real tool evidence: a passing check relevant to any solution it claims,
 * or an observed failure for negative findings. Prose claims never count as
 * proof. Admission is serialized per logical bank: an in-process queue plus the
 * native file lock. Candidate recall, the duplicate decision, and every write or
 * replacement happen inside that lock. Replacements are atomic.
 * Before extraction, the bounded assignment, transcript, result, and evidence pass
 * through the native memory secret redaction, and a lesson echoing a `$$…$$` secret
 * placeholder back from the model is rejected. Background-job receipts that never
 * settled are not evidence: they prove nothing about the command.
 *
 * Recall spends zero model calls. Schema rows are project-scoped and re-check
 * their stored file fingerprints. Legacy rows are never dropped: they surface
 * with an explicit re-verify caveat.
 *
 * Model cost is bounded per checkpoint: at most ONE completion. The completion
 * runs on the configured inexpensive `memory` role and only when the run had
 * admissible evidence.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { JsonValue, Metadata, Mnemopi, RecallResult, RememberFacadeOptions } from "@oh-my-pi/pi-mnemopi";
import { isRecord, logger, prompt, withFileLock } from "@oh-my-pi/pi-utils";
import { truncateRecallQuery } from "../hindsight/content";
import { redactMemorySecrets } from "../memory-backend/redact";
import experienceExtractionPrompt from "../prompts/system/experience-lesson-extraction.md" with { type: "text" };
import { PLACEHOLDER_RE } from "../secrets/placeholder";
import { truncateApproxTokens } from "./config";
import type { MnemopiSessionState } from "./state";

export interface ExperienceMemoryRef {
	id: string;
	bank: string;
	content: string;
}

export interface ExperienceToolEvidence {
	toolCallId?: string;
	tool: string;
	request?: string;
	ok: boolean;
	output?: string;
	exitCode?: number;
}

export interface ExperienceProjectContext {
	projectKey: string;
	repoRoot?: string;
	origin?: string;
}

export interface ExperienceRecallInput {
	state: MnemopiSessionState;
	assignment: string;
	project: ExperienceProjectContext;
	exclude?: readonly ExperienceMemoryRef[];
	tokenBudget?: number;
	signal?: AbortSignal;
}

export interface ExperienceRecallResult {
	context?: string;
	memories: readonly ExperienceMemoryRef[];
}

export interface ExperienceRevalidateInput {
	state: MnemopiSessionState;
	memories: readonly ExperienceMemoryRef[];
	project: ExperienceProjectContext;
	signal?: AbortSignal;
}

export interface ExperienceRevalidateResult {
	changed: boolean;
	memories: ExperienceMemoryRef[];
	context?: string;
}

export type ExperienceRunStatus = "success" | "failure" | "aborted" | "unknown";

/** One completion on the inexpensive memory role. Undefined when unavailable. */
export type ExperienceCompleter = (text: string, system?: string, signal?: AbortSignal) => Promise<string | undefined>;

export interface ExperienceCaptureInput {
	state: MnemopiSessionState;
	assignment: string;
	project: ExperienceProjectContext;
	messages: ReadonlyArray<{ role: string; content: string }>;
	toolEvidence?: readonly ExperienceToolEvidence[];
	resultText?: string;
	status: ExperienceRunStatus;
	completeLlm: ExperienceCompleter;
	agentKind?: string;
	signal?: AbortSignal;
}

export interface ExperienceCaptureResult {
	written: number;
	updated: number;
	superseded: number;
	rejected: string;
	llmCalls: number;
	memories: readonly ExperienceMemoryRef[];
}

export interface ExperienceLesson {
	kind: "solution" | "negative" | "pitfall";
	title: string;
	situation: string;
	problem: string;
	rootCause: string;
	solution: string;
	pitfall: string;
	evidence: string;
	evidenceRefs: string[];
	scope: string;
	conditions: string[];
	decision: "new" | "duplicate" | "update";
	decisionId: string | null;
}

export interface ExtractionReply {
	lessons: ExperienceLesson[];
	error?: string;
}

export type GateVerdict = { ok: true } | { ok: false; reason: string };

export type ConditionVerdict = { ok: true; paths: string[] } | { ok: false; reason: "unsafe-conditions" | "too-many-conditions" };

/** Host-side snapshot of one capture window, built by `collectExperienceEvidence`. */
export interface ExperienceEvidenceSnapshot {
	/** Flattened real transcript (role/content pairs) for the capture window. */
	messages: Array<{ role: string; content: string }>;
	/** Real tool results; `ok` derives strictly from the result, never from prose. */
	toolEvidence: ExperienceToolEvidence[];
	/** Last assistant text: the run's report. Prose, never proof. */
	resultText: string | undefined;
}

const EXPERIENCE_SOURCE = "coding-agent-learn";
const SCHEMA_KEY = "exp:schema";
const SCHEMA_VERSION = "1";
const PROJECT_KEY = "exp:project";
const AGENT_KEY = "exp:agent";
const KIND_KEY = "exp:kind";
const EVIDENCE_KEY = "exp:evidence";
const FINGERPRINT_KEY = "exp:fingerprints";
const CONDITIONS_KEY = "exp:conditions";
const CAPTURED_KEY = "exp:captured";
const SUPERSEDES_KEY = "exp:supersedes";
const NO_LESSONS = "NO_LESSONS";
const LEGACY_CAVEAT = "[legacy memory — unverified provenance; re-check against current code before relying]";
const RECALL_HEADER =
	"Relevant verified experience from prior agents on this project (background knowledge; current code and tests take precedence):";

const MAX_RECALLED = 4;
const MAX_LESSONS_PER_CAPTURE = 2;
const MAX_DEDUPE_CANDIDATES = 8;
const MAX_DEDUPE_SCAN = 2000;
const MAX_EVIDENCE_ENTRIES = 24;
const EVIDENCE_OUTPUT_TAIL = 600;
const EVIDENCE_REQUEST_HEAD = 400;
const MAX_TRANSCRIPT_CHARS = 8000;
const TRANSCRIPT_MESSAGE_CAP = 400;
const TRANSCRIPT_HEAD = 4;
const TRANSCRIPT_TAIL = 20;
const MAX_ASSIGNMENT_CHARS = 2000;
const MAX_RESULT_CHARS = 2000;
const MAX_CANDIDATE_CHARS = 400;
const MAX_TITLE_CHARS = 120;
const MAX_FIELD_CHARS = 600;
const MAX_CONTENT_CHARS = 3000;
const MAX_FINGERPRINT_PATHS = 8;
const FINGERPRINT_PREFIX_CHARS = 16;
const MAX_FILE_FINGERPRINT_BYTES = 1 << 20;
const SCHEMA_MIN_OVERLAP = 1;
const LEGACY_MIN_OVERLAP = 2;
const EVIDENCE_MIN_OVERLAP = 2;
const LEGACY_FACT_MIN_OVERLAP = 2;
const DUPLICATE_JACCARD = 0.8;
const EXPERIENCE_EVIDENCE_CAP = 64;
const BANK_LOCK_OPTIONS = { retries: 600, retryDelayMs: 200 };

/**
 * Evidence tools that count as checks; a web-URL target never does, and `bash`/`eval` count only when a command
 * segment reads like one.
 */
const CHECK_EVIDENCE_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, "xd://lsp": true };
const CHECK_EVIDENCE_PATTERN =
	/\b(test|tests|spec|lint|build|tsc|typecheck|assert|assertion|expect|diff|verify|check|pytest|jest|vitest|mocha|gradle|javap|aapt2?)\b|bun test|npm run|yarn run|pnpm (run|test)|go (test|vet)|make (test|check|lint)|cargo (test|clippy)/i;
/** A web-URL request: a fetched page is remote prose, never a check of this project. */
const URL_TARGET_PATTERN = /^(?:https?:\/\/|www\.)/i;
/** Shell operators a `bash`/`eval` request splits on, so one real runner survives beside noise. */
const COMMAND_SEGMENT_PATTERN = /&&|\|\||[|;\n]/;
/**
 * Commands that only print, read, or fetch bytes. Their arguments may quote test-shaped words — `echo 'tests
 * pass'`, `cat x.test.ts`, `curl https://…/test-report` — but running one never verifies anything.
 */
const NON_CHECK_COMMAND_PATTERN =
	/^(?:echo|printf|cat|head|tail|less|more|nl|od|xxd|strings|wc|ls|pwd|true|:|curl|wget|fetch)(?=$|\s)/i;
/** PLACEHOLDER_RE is a shared global regex (stateful `lastIndex`); lessons are tested through this stateless copy. */
const LESSON_PLACEHOLDER_RE = new RegExp(PLACEHOLDER_RE.source);

const UNSAFE_CONDITION_SEGMENTS: Record<string, true> = {
	node_modules: true,
	".git": true,
	dist: true,
	build: true,
	".next": true,
	out: true,
	target: true,
	coverage: true,
	__pycache__: true,
	".venv": true,
	vendor: true,
	".cache": true,
};

const STOPWORDS: Record<string, true> = {
	about: true,
	after: true,
	again: true,
	agent: true,
	also: true,
	although: true,
	always: true,
	another: true,
	answer: true,
	because: true,
	been: true,
	before: true,
	being: true,
	between: true,
	both: true,
	cannot: true,
	check: true,
	code: true,
	config: true,
	could: true,
	current: true,
	does: true,
	done: true,
	during: true,
	each: true,
	else: true,
	enough: true,
	ensure: true,
	error: true,
	every: true,
	example: true,
	exists: true,
	failed: true,
	failure: true,
	false: true,
	file: true,
	files: true,
	fixed: true,
	found: true,
	from: true,
	have: true,
	here: true,
	into: true,
	issue: true,
	just: true,
	keep: true,
	lesson: true,
	main: true,
	make: true,
	memory: true,
	message: true,
	must: true,
	need: true,
	note: true,
	occur: true,
	other: true,
	over: true,
	perform: true,
	please: true,
	possible: true,
	problem: true,
	project: true,
	result: true,
	returns: true,
	should: true,
	since: true,
	solution: true,
	some: true,
	start: true,
	state: true,
	still: true,
	stored: true,
	task: true,
	test: true,
	tests: true,
	that: true,
	them: true,
	there: true,
	these: true,
	they: true,
	this: true,
	those: true,
	through: true,
	true: true,
	under: true,
	until: true,
	used: true,
	using: true,
	verify: true,
	want: true,
	when: true,
	where: true,
	which: true,
	while: true,
	will: true,
	with: true,
	without: true,
	work: true,
	worked: true,
	working: true,
	your: true,
};

const TINY_STOPWORDS: Record<string, true> = {
	the: true,
	and: true,
	for: true,
	with: true,
	that: true,
	this: true,
	from: true,
	are: true,
	was: true,
	not: true,
	but: true,
	all: true,
	can: true,
	will: true,
	one: true,
	two: true,
	you: true,
	how: true,
	why: true,
	who: true,
	its: true,
	our: true,
	out: true,
	get: true,
	set: true,
	use: true,
	run: true,
	has: true,
	had: true,
	did: true,
	does: true,
	let: true,
	may: true,
	new: true,
	now: true,
	see: true,
	way: true,
	into: true,
	when: true,
	than: true,
	then: true,
	them: true,
};

const EVIDENCE_REQUEST_ARG_KEYS: readonly string[] = [
	"command",
	"code",
	"script",
	"query",
	"pattern",
	"path",
	"file",
	"filePath",
	"url",
	"intent",
	"prompt",
	"task",
	"content",
];

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isMetadata(value: unknown): value is Metadata {
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

/** Native metadata from a stored row: JSON text or an already-decoded object. Anything else is rejected. */
function parseMetadata(value: unknown): Metadata | undefined {
	let decoded: unknown = value;
	if (typeof value === "string") {
		try {
			decoded = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return isMetadata(decoded) ? decoded : undefined;
}

function textField(source: Record<string, unknown>, key: string): string {
	const value = source[key];
	return typeof value === "string" ? value : "";
}

function textList(source: Record<string, unknown>, key: string): string[] {
	const value = source[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clampText(value: string, max: number): string {
	const text = value.trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1).trimEnd()}…`;
}

function significantTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const token of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
		if (token.length >= 4 && STOPWORDS[token] !== true) tokens.add(token);
	}
	return tokens;
}

function relevanceTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const token of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
		if (token.length >= 3 && TINY_STOPWORDS[token] !== true) tokens.add(token);
	}
	return tokens;
}

function tokenOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let count = 0;
	for (const token of a) {
		if (b.has(token)) count++;
	}
	return count;
}

function tokenJaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	const overlap = tokenOverlap(a, b);
	return overlap / (a.size + b.size - overlap);
}

/** Plain text of message content: a string, or the joined text blocks of an array. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		parts.push(block.text);
	}
	return parts.join("\n");
}

/** Bounded request text for one tool call's evidence entry. */
function boundToolRequest(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	for (const key of EVIDENCE_REQUEST_ARG_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.slice(0, EVIDENCE_REQUEST_HEAD);
	}
	try {
		return JSON.stringify(args).slice(0, EVIDENCE_REQUEST_HEAD);
	} catch {
		return undefined;
	}
}

/**
 * Collect real transcript + tool-result evidence from live agent messages.
 * `fromIndex` slices a MAIN checkpoint to messages unseen since the last capture.
 * Evidence keeps the host cap (tail wins); `ok` is `isError === false` and,
 * when the tool reports one, `exitCode === 0`. A background-job receipt whose
 * `details.async` never reached a terminal state is kept out of evidence: its
 * text is a promise, not a result, and proves nothing in either direction.
 */
export function collectExperienceEvidence(
	agentMessages: readonly AgentMessage[],
	fromIndex = 0,
): ExperienceEvidenceSnapshot {
	const messages: Array<{ role: string; content: string }> = [];
	const requests = new Map<string, string>();
	const toolEvidence: ExperienceToolEvidence[] = [];
	let resultText: string | undefined;
	for (const message of agentMessages.slice(Math.max(0, fromIndex))) {
		if (message.role === "assistant") {
			let text = "";
			for (const block of message.content) {
				if (typeof block !== "object" || block === null) continue;
				if (block.type === "toolCall") {
					const request = boundToolRequest(block.arguments);
					if (request !== undefined) requests.set(block.id, request);
				} else if (block.type === "text" && block.text.trim()) {
					text += (text ? "\n" : "") + block.text;
				}
			}
			if (text.trim()) {
				messages.push({ role: "assistant", content: text });
				resultText = text;
			}
		} else if (message.role === "toolResult") {
			const text = contentText(message.content);
			const details = message.details;
			if (!isUnsettledAsyncReceipt(details)) {
				const request = requests.get(message.toolCallId);
				const exitCode =
					typeof details === "object" && details !== null && "exitCode" in details && typeof details.exitCode === "number"
						? details.exitCode
						: undefined;
				toolEvidence.push({
					toolCallId: message.toolCallId,
					tool: message.toolName,
					...(request !== undefined ? { request } : {}),
					ok: !message.isError && (exitCode === undefined || exitCode === 0),
					output: text.trim().slice(-EVIDENCE_OUTPUT_TAIL),
					...(exitCode !== undefined ? { exitCode } : {}),
				});
			}
			if (text.trim()) messages.push({ role: "toolResult", content: `${message.toolName}: ${text}` });
		} else if (message.role === "user") {
			const text = contentText(message.content);
			if (text.trim()) messages.push({ role: "user", content: text });
		}
	}
	if (toolEvidence.length > EXPERIENCE_EVIDENCE_CAP) {
		toolEvidence.splice(0, toolEvidence.length - EXPERIENCE_EVIDENCE_CAP);
	}
	return { messages, toolEvidence, resultText };
}

/**
 * True when `details.async` marks a background-job frame that never settled: a `running` receipt, or one without a
 * terminal `completed`/`failed`/`cancelled` state. No async-tracking framework is built around them — an unsettled
 * frame is simply dropped from evidence; terminal frames derive `ok` as usual.
 */
function isUnsettledAsyncReceipt(details: unknown): boolean {
	if (!isRecord(details) || !isRecord(details.async)) return false;
	const state = details.async.state;
	return state !== "completed" && state !== "failed" && state !== "cancelled";
}

function hasOutput(entry: ExperienceToolEvidence): boolean {
	return (entry.output ?? "").trim() !== "";
}

function isCheckEvidence(entry: ExperienceToolEvidence): boolean {
	const request = (entry.request ?? "").trim();
	if (CHECK_EVIDENCE_TOOLS[entry.tool] === true) return !URL_TARGET_PATTERN.test(request);
	if (entry.tool !== "bash" && entry.tool !== "eval") return false;
	return request.split(COMMAND_SEGMENT_PATTERN).some(segment => {
		const command = segment.trim();
		return command !== "" && !NON_CHECK_COMMAND_PATTERN.test(command) && CHECK_EVIDENCE_PATTERN.test(command);
	});
}

function resolveEvidenceRef(
	ref: string,
	evidence: readonly ExperienceToolEvidence[],
): ExperienceToolEvidence | undefined {
	const trimmed = ref.trim();
	if (trimmed === "") return undefined;
	const indexed = /^e(\d+)$/i.exec(trimmed);
	if (indexed) {
		const index = Number(indexed[1]) - 1;
		if (index >= 0 && index < evidence.length) return evidence[index];
	}
	const byCallId = evidence.find(entry => entry.toolCallId === trimmed);
	if (byCallId !== undefined) return byCallId;
	if (trimmed.length < 8) return undefined;
	return evidence.find(entry => (entry.request ?? "").includes(trimmed));
}

/**
 * Admission gate for one lesson. A solution needs a passing check that is relevant to its claim, and a successful
 * run. A negative finding needs an observed failure or a relevant check. Relevance is measured on the lesson's own
 * claim tokens: words the claim shares with the assignment neither add to nor subtract from them, so a genuine
 * check of the assigned subject — a real date-parsing test under a date-parsing assignment — stays admissible.
 */
export function verifyEvidenceGate(
	lesson: ExperienceLesson,
	evidence: readonly ExperienceToolEvidence[],
	runStatus: ExperienceRunStatus = "success",
): GateVerdict {
	if (lesson.evidenceRefs.length === 0) return { ok: false, reason: "no-evidence-refs" };
	const cited: ExperienceToolEvidence[] = [];
	for (const ref of lesson.evidenceRefs) {
		const entry = resolveEvidenceRef(ref, evidence);
		if (entry === undefined) return { ok: false, reason: `evidence-ref-unresolved:${ref}` };
		if (!hasOutput(entry)) return { ok: false, reason: `evidence-empty-output:${ref}` };
		cited.push(entry);
	}
	const claimsSolution = lesson.kind === "solution" || lesson.solution.trim() !== "";
	const claimed = claimsSolution ? lesson.solution : lesson.pitfall;
	const claimTokens = relevanceTokens([lesson.title, lesson.problem, lesson.rootCause, claimed].join("\n"));
	const relevant = cited.filter(entry => {
		const entryTokens = relevanceTokens(`${entry.request ?? ""}\n${entry.output ?? ""}`);
		return tokenOverlap(claimTokens, entryTokens) >= EVIDENCE_MIN_OVERLAP;
	});
	if (claimsSolution) {
		if (runStatus !== "success") return { ok: false, reason: "solution-claimed-on-unsuccessful-run" };
		const checks = cited.filter(isCheckEvidence);
		const passing = checks.filter(entry => entry.ok);
		if (passing.length === 0) {
			return { ok: false, reason: checks.length > 0 ? "failed-check-cited-as-proof" : "no-check-class-proof" };
		}
		if (!passing.some(entry => relevant.includes(entry))) {
			return { ok: false, reason: "evidence-not-relevant-to-lesson" };
		}
		return { ok: true };
	}
	const observed = cited.filter(entry => !entry.ok || isCheckEvidence(entry));
	if (observed.length === 0) return { ok: false, reason: "no-observed-failure" };
	if (!observed.some(entry => relevant.includes(entry))) {
		return { ok: false, reason: "evidence-not-relevant-to-lesson" };
	}
	return { ok: true };
}

// Repeated labels are all dropped, so a field value that repeats its own label leaves no label words behind.
const LESSON_LABEL_PREFIX =
	/^(?:(?:LESSON\[v1\] \([a-z]+\)|Situation:|Problem:|Root cause:|Proven solution:|Pitfall:|Scope:)\s*)+/;
const LESSON_META_LINE = /^(?:Evidence|Conditions):/;

/** Stored lesson text: a `LESSON[v1]` title line, then one labeled line per non-empty field. */
export function renderLessonContent(lesson: ExperienceLesson): string {
	const lines = [`LESSON[v1] (${lesson.kind}) ${lesson.title.trim()}`];
	const fields: [string, string][] = [
		["Situation", lesson.situation],
		["Problem", lesson.problem],
		["Root cause", lesson.rootCause],
		["Proven solution", lesson.solution],
		["Pitfall", lesson.pitfall],
		["Evidence", lesson.evidence],
		["Scope", lesson.scope],
	];
	for (const [label, text] of fields) {
		if (text.trim() !== "") lines.push(`${label}: ${text.trim()}`);
	}
	if (lesson.conditions.length > 0) lines.push(`Conditions: ${lesson.conditions.join(", ")}`);
	return lines.join("\n");
}

/** Applicability text: label prefixes and Evidence/Conditions lines are dropped before overlap matching. */
function applicabilityText(content: string): string {
	return content
		.split("\n")
		.filter(line => !LESSON_META_LINE.test(line))
		.map(line => line.replace(LESSON_LABEL_PREFIX, ""))
		.join("\n");
}

/** Why a lesson exceeds its budgets, if it does. Over-budget lessons are rejected, never truncated. */
function budgetViolation(lesson: ExperienceLesson, content: string): string | undefined {
	if (lesson.title.trim().length > MAX_TITLE_CHARS) return "field-over-budget";
	const fields = [
		lesson.situation,
		lesson.problem,
		lesson.rootCause,
		lesson.solution,
		lesson.pitfall,
		lesson.evidence,
		lesson.scope,
	];
	if (fields.some(field => field.trim().length > MAX_FIELD_CHARS)) return "field-over-budget";
	if (content.length > MAX_CONTENT_CHARS) return "content-over-budget";
	return undefined;
}

/** One lesson from untrusted JSON. Anything malformed or of an unknown kind yields undefined. */
function parseLesson(raw: unknown): ExperienceLesson | undefined {
	if (!isRecord(raw)) return undefined;
	const title = textField(raw, "title").replace(/\s+/g, " ").trim();
	if (title === "") return undefined;
	const kind = textField(raw, "kind");
	if (kind !== "solution" && kind !== "negative" && kind !== "pitfall") return undefined;
	const decision = textField(raw, "decision");
	return {
		kind,
		title,
		situation: textField(raw, "situation"),
		problem: textField(raw, "problem"),
		rootCause: textField(raw, "rootCause"),
		solution: textField(raw, "solution"),
		pitfall: textField(raw, "pitfall"),
		evidence: textField(raw, "evidence"),
		evidenceRefs: textList(raw, "evidenceRefs"),
		scope: textField(raw, "scope"),
		conditions: textList(raw, "conditions"),
		decision: decision === "duplicate" || decision === "update" ? decision : "new",
		decisionId: textField(raw, "decisionId").trim() || null,
	};
}

/** Parses one completion. Malformed output yields zero lessons and a reason; it never throws. */
export function parseExtractionReply(reply: string): ExtractionReply {
	const text = reply.trim();
	if (text === "") return { lessons: [], error: "empty-reply" };
	if (text.includes(NO_LESSONS)) return { lessons: [] };
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return { lessons: [], error: "no-json" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch (error) {
		return { lessons: [], error: `json-parse:${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isRecord(parsed)) return { lessons: [], error: "no-json-object" };
	const lessonsField = parsed.lessons;
	if (!Array.isArray(lessonsField)) return { lessons: [], error: "no-lessons-array" };
	const rawLessons: unknown[] = lessonsField;
	const lessons: ExperienceLesson[] = [];
	for (const raw of rawLessons.slice(0, MAX_LESSONS_PER_CAPTURE)) {
		const lesson = parseLesson(raw);
		if (lesson !== undefined) lessons.push(lesson);
	}
	if (lessons.length === 0 && rawLessons.length > 0) return { lessons, error: "lessons-invalid" };
	return { lessons };
}

/** Lesson condition paths: repo-relative, bounded, never inside generated or dependency trees. Any unsafe entry rejects the list. */
export function sanitizeConditions(paths: readonly string[]): ConditionVerdict {
	if (paths.length > MAX_FINGERPRINT_PATHS) return { ok: false, reason: "too-many-conditions" };
	const accepted = new Set<string>();
	for (const raw of paths) {
		const rel = raw.trim();
		const unsafe =
			rel === "" ||
			path.isAbsolute(rel) ||
			rel.split(/[\\/]/).some(segment => segment === ".." || UNSAFE_CONDITION_SEGMENTS[segment] === true);
		if (unsafe) return { ok: false, reason: "unsafe-conditions" };
		accepted.add(rel);
	}
	return { ok: true, paths: [...accepted] };
}

/** Content fingerprints keyed by repo-relative path. A missing, non-file, or oversized path maps to null. */
export function fingerprintPaths(repoRoot: string, relPaths: readonly string[]): Record<string, string | null> {
	const entries: [string, string | null][] = [];
	for (const rel of relPaths) entries.push([rel, fingerprintFile(path.resolve(repoRoot, rel))]);
	return Object.fromEntries(entries);
}

function fingerprintFile(target: string): string | null {
	try {
		const stat = statSync(target);
		if (!stat.isFile() || stat.size > MAX_FILE_FINGERPRINT_BYTES) return null;
		return createHash("sha256").update(readFileSync(target)).digest("hex").slice(0, FINGERPRINT_PREFIX_CHARS);
	} catch {
		return null;
	}
}

function isSchemaLesson(metadata: Metadata | undefined): boolean {
	return metadata !== undefined && metadata[SCHEMA_KEY] === SCHEMA_VERSION;
}

/** A schema row applies only to its own project, and only while its fingerprinted conditions still hold. */
function schemaApplies(metadata: Metadata | undefined, project: ExperienceProjectContext): boolean {
	if (metadata?.[PROJECT_KEY] !== project.projectKey) return false;
	return conditionsHold(metadata, project.repoRoot);
}

/** Re-checks stored fingerprints. A stored list that cannot be re-validated or re-hashed fails closed. */
function conditionsHold(metadata: Metadata | undefined, repoRoot: string | undefined): boolean {
	const stored = metadata?.[FINGERPRINT_KEY];
	if (stored === undefined) return true;
	if (!isRecord(stored)) return false;
	const paths = Object.keys(stored);
	if (paths.length === 0) return true;
	const safe = sanitizeConditions(paths);
	if (!safe.ok || repoRoot === undefined) return false;
	const current = fingerprintPaths(repoRoot, safe.paths);
	return paths.every(rel => typeof stored[rel] === "string" && stored[rel] === current[rel]);
}

/** Admission queue per bank inside this process. The native file lock then serializes across processes. */
const lockTails = new Map<string, Promise<void>>();

function bankLockKey(state: MnemopiSessionState): string {
	const retain = state.getScopedRetainTarget();
	const dbPath = retain.memory.dbPath ?? state.config.dbPath;
	return dbPath === ":memory:" ? path.join(tmpdir(), `omp-experience-${retain.bank}.lock`) : `${dbPath}.experience`;
}

/** Waits for `previous`, or rejects as soon as `signal` aborts so a queued admission never outlives its run. */
function awaitTurn(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) return previous;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<void>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		previous.then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}

/** Runs `fn` as the only admission for this bank: in-process queue first, then the cross-process file lock. */
async function withBankLock<T>(
	state: MnemopiSessionState,
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	const key = bankLockKey(state);
	const previous = lockTails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>(resolve => {
		release = resolve;
	});
	lockTails.set(key, current);
	try {
		await awaitTurn(previous, signal);
		return await withFileLock(key, fn, signal ? { ...BANK_LOCK_OPTIONS, signal } : BANK_LOCK_OPTIONS);
	} finally {
		release();
		if (lockTails.get(key) === current) lockTails.delete(key);
	}
}

/** A row admitted to a recall block. Legacy rows keep the re-verify caveat; verified rows are marked as checked. */
interface RecallEntry {
	ref: ExperienceMemoryRef;
	verified: boolean;
}

/** Recall block for the next run. Legacy rows carry the caveat; verified rows are labelled as checked. */
function renderRecallBlock(entries: readonly RecallEntry[]): string {
	const lines = [RECALL_HEADER];
	for (const { ref, verified } of entries) {
		lines.push(
			verified
				? `- ${ref.content} (id: ${ref.id}) [verified-experience]`
				: `- ${LEGACY_CAVEAT} ${ref.content} (id: ${ref.id})`,
		);
	}
	return lines.join("\n");
}

/**
 * Recall for the next run. No model call: native recall, then per-row checks against the live store. A verified row applies
 * only to its own project while its fingerprinted conditions hold. A legacy row needs stronger overlap and keeps its caveat.
 */
export async function recallExperience(input: ExperienceRecallInput): Promise<ExperienceRecallResult> {
	const { state, project, exclude, signal } = input;
	const query = input.assignment.trim();
	if (!state.config.experienceEnabled || query === "") return { memories: [] };
	let results: RecallResult[];
	try {
		const recallQuery = truncateRecallQuery(query, query, state.config.recallMaxQueryChars);
		results = await state.collectScopedRecallResults(recallQuery);
	} catch (error) {
		logger.warn("Experience: scoped recall failed", { error: String(error) });
		return { memories: [] };
	}
	if (signal?.aborted || results.length === 0) return { memories: [] };
	const excluded = exclude ?? [];
	const excludedIds = new Set(excluded.map(ref => ref.id));
	const excludedContent = new Set(excluded.map(ref => ref.content));
	const assignmentTokens = significantTokens(query);
	const budget = input.tokenBudget ?? state.config.injectionTokenLimit;
	const entries: RecallEntry[] = [];
	for (const result of results) {
		if (entries.length >= MAX_RECALLED) break;
		const hit = state.getScopedMemory(result.id);
		// Only working-memory explicit lessons carry experience; derived facts and transcript episodes are noise here.
		if (!hit || hit.invalidated || hit.store !== "working") continue;
		const content = hit.row.content;
		if (excludedIds.has(hit.row.id) || excludedContent.has(content)) continue;
		const metadata = parseMetadata(hit.row.metadata);
		const verified = isSchemaLesson(metadata);
		if (verified && !schemaApplies(metadata, project)) continue;
		// Overlap is measured on claim text, so schema labels such as "Situation:" never count as relevance.
		const overlap = tokenOverlap(assignmentTokens, significantTokens(applicabilityText(content)));
		if (overlap < (verified ? SCHEMA_MIN_OVERLAP : LEGACY_MIN_OVERLAP)) continue;
		const entry: RecallEntry = { ref: { id: hit.row.id, bank: hit.bank, content }, verified };
		// Budget whole lessons only; a lesson that does not fit is skipped.
		const block = renderRecallBlock([...entries, entry]);
		if (truncateApproxTokens(block, budget) !== block) continue;
		entries.push(entry);
	}
	if (entries.length === 0) return { memories: [] };
	return { context: renderRecallBlock(entries), memories: entries.map(entry => entry.ref) };
}

/**
 * Re-checks previously recalled rows on an unchanged continuation, with no model call and no native recall. A row survives
 * while it is live in its bank with the same content; a verified row must also still apply to this project.
 */
export function revalidateExperienceContext(input: ExperienceRevalidateInput): ExperienceRevalidateResult {
	const { state, memories, project } = input;
	const entries: RecallEntry[] = [];
	for (const ref of memories) {
		const hit = state.getScopedMemory(ref.id);
		if (!hit || hit.invalidated || hit.store !== "working" || hit.bank !== ref.bank) continue;
		if (hit.row.content !== ref.content) continue;
		const metadata = parseMetadata(hit.row.metadata);
		const verified = isSchemaLesson(metadata);
		if (verified && !schemaApplies(metadata, project)) continue;
		entries.push({ ref, verified });
	}
	if (entries.length === memories.length) return { changed: false, memories: [...memories] };
	if (entries.length === 0) return { changed: true, memories: [] };
	return { changed: true, memories: entries.map(entry => entry.ref), context: renderRecallBlock(entries) };
}

/** Run transcript for the extraction prompt: opening and closing turns, with the middle elided when long. */
function buildTranscriptDigest(messages: ExperienceCaptureInput["messages"]): string {
	if (messages.length === 0) return "(no transcript)";
	const lines = messages.map(message => `[role: ${message.role}] ${clampText(message.content, TRANSCRIPT_MESSAGE_CAP)}`);
	const kept =
		lines.length > TRANSCRIPT_HEAD + TRANSCRIPT_TAIL
			? [...lines.slice(0, TRANSCRIPT_HEAD), "(… middle elided …)", ...lines.slice(-TRANSCRIPT_TAIL)]
			: lines;
	return clampText(kept.join("\n"), MAX_TRANSCRIPT_CHARS);
}

/** Tool evidence for the extraction prompt. `E<n>` labels are the positions `evidenceRefs` resolve against. */
function renderEvidenceDigest(evidence: readonly ExperienceToolEvidence[]): string {
	if (evidence.length === 0) return "(no tool evidence)";
	return evidence
		.map((entry, index) => {
			const flags = [`ok=${entry.ok}`];
			if (entry.exitCode !== undefined) flags.push(`exit=${entry.exitCode}`);
			if (entry.toolCallId !== undefined) flags.push(`callId=${entry.toolCallId}`);
			const request = entry.request ?? "(none)";
			const output = hasOutput(entry) ? entry.output : "(empty)";
			return `E${index + 1} tool=${entry.tool} ${flags.join(" ")}\n  request: ${request}\n  output: ${output}`;
		})
		.join("\n");
}

/** An existing row the extraction may update, or must not duplicate. */
interface DedupeCandidate {
	id: string;
	content: string;
	metadata: Metadata | undefined;
}

/** The retain target: the one bank a run reads and writes. */
interface OwningBank {
	bank: string;
	memory: Mnemopi;
}

/** A stored row that still holds: not superseded, not expired, in its owning bank. */
interface LiveWrite {
	id: string;
	/** The live row that superseded this id; `"expired"` when only its `valid_until` hides it. */
	hiddenBy: string | null;
	/** Row's `exp:captured` stamp, undefined for a row without schema metadata. */
	captured: string | undefined;
}

/**
 * Whether a native `remember` result is a row this bank actually serves. The duplicate branch of `remember` can
 * return a superseded/invalidated row id for identical content without un-hiding it, so a capture must verify the
 * returned id is live before it counts as a write; the superseder id and capture stamp come back so the repair can
 * retire the one and re-run the other's metadata refresh.
 */
function liveWriteInOwningBank(owner: OwningBank, id: string | undefined): LiveWrite | undefined {
	if (!id) return undefined;
	try {
		const row = owner.memory.db
			.query(
				`SELECT id, superseded_by, valid_until, metadata_json FROM working_memory WHERE id = ?
				 UNION ALL
				 SELECT id, superseded_by, valid_until, metadata_json FROM episodic_memory WHERE id = ?`,
			)
			.get(id, id) as { id: string; superseded_by: string | null; valid_until: string | null; metadata_json: string | null } | undefined;
		if (row === undefined) return undefined;
		const expired = row.valid_until !== null && Date.parse(row.valid_until) <= Date.now();
		const captured = parseMetadata(row.metadata_json)?.[CAPTURED_KEY];
		const stamp = typeof captured === "string" ? captured : undefined;
		if (row.superseded_by === null && !expired) return { id: row.id, hiddenBy: null, captured: stamp };
		return { id: row.id, hiddenBy: row.superseded_by ?? "expired", captured: stamp };
	} catch (error) {
		logger.warn("Experience: write liveness check failed", { id, error: String(error) });
		return undefined;
	}
}

/**
 * One run's duplicate surface, kept current as the run admits lessons. `candidates` is what the extraction sees and the only
 * rows an update may name. `known` is every live lesson a new one must not duplicate: the candidates plus the scanned schema
 * lessons. `scanned` is that complete live set, kept for the supersession-chain retirement a repair walks.
 */
interface DedupeSet {
	candidates: DedupeCandidate[];
	known: DedupeCandidate[];
	scanned: DedupeCandidate[];
}

/**
 * Native recall on the owning bank. The enhanced path runs first; if it throws, the same query runs lexically, so a broken
 * vector path does not drop the search. Undefined only when both paths throw.
 */
async function searchOwningBank(owner: OwningBank, query: string): Promise<RecallResult[] | undefined> {
	try {
		return await owner.memory.recallEnhanced(query, MAX_DEDUPE_CANDIDATES, {
			includeFacts: false,
			channelId: owner.bank,
		});
	} catch (error) {
		logger.warn("Experience: dedupe enhanced search failed; retrying lexically", {
			bank: owner.bank,
			error: String(error),
		});
	}
	try {
		return await owner.memory.recall(query, MAX_DEDUPE_CANDIDATES, {
			channelId: owner.bank,
			queryEmbedding: null,
		});
	} catch (error) {
		logger.warn("Experience: dedupe lexical search failed", { bank: owner.bank, error: String(error) });
		return undefined;
	}
}

/** Row shape the duplicate scan reads from either native store. */
interface ScanRow {
	id: string;
	content: string;
	metadata_json: string | null;
}

/**
 * Live schema lessons of one project in the owning bank, read from both native stores. The scan is complete by design:
 * recall returns a bounded top-k and cannot prove that a lesson is new. Undefined when the read throws or the project holds
 * more than MAX_DEDUPE_SCAN live lessons, since a partial scan cannot prove that either.
 */
function scanOwningBank(owner: OwningBank, projectKey: string): DedupeCandidate[] | undefined {
	const now = new Date().toISOString();
	const project = `%${JSON.stringify(PROJECT_KEY)}:${JSON.stringify(projectKey)}%`;
	let rows: ScanRow[];
	try {
		rows = owner.memory.db
			.query(
				`SELECT id, content, metadata_json FROM working_memory
				 WHERE superseded_by IS NULL AND (valid_until IS NULL OR valid_until > ?) AND channel_id = ? AND metadata_json LIKE ?
				 UNION ALL
				 SELECT id, content, metadata_json FROM episodic_memory
				 WHERE superseded_by IS NULL AND (valid_until IS NULL OR valid_until > ?) AND channel_id = ? AND metadata_json LIKE ?
				 LIMIT ?`,
			)
			.all(now, owner.bank, project, now, owner.bank, project, MAX_DEDUPE_SCAN + 1) as ScanRow[];
	} catch (error) {
		logger.warn("Experience: dedupe scan failed", { bank: owner.bank, error: String(error) });
		return undefined;
	}
	if (rows.length > MAX_DEDUPE_SCAN) {
		logger.warn("Experience: dedupe scan over bound", { bank: owner.bank, bound: MAX_DEDUPE_SCAN });
		return undefined;
	}
	const lessons = new Map<string, DedupeCandidate>();
	for (const row of rows) {
		const metadata = parseMetadata(row.metadata_json);
		if (isSchemaLesson(metadata) && metadata?.[PROJECT_KEY] === projectKey) {
			lessons.set(row.id, { id: row.id, content: row.content, metadata });
		}
	}
	return [...lessons.values()];
}

/**
 * The run's duplicate surface. Owning-bank hits form the digest: working rows and episodic rows that are lessons, either
 * schema lessons of this project or legacy lessons. A deterministic scan adds every live schema lesson of the project, so a
 * new lesson is checked against all of them, not only the top hits. Runs under the bank lock. Undefined when a search, a
 * load, or the scan fails: an incomplete list cannot prove a lesson is new, so the run admits nothing.
 */
async function collectDedupeSet(
	state: MnemopiSessionState,
	assignment: string,
	projectKey: string,
): Promise<DedupeSet | undefined> {
	const owner = state.getScopedRetainTarget();
	const query = truncateRecallQuery(assignment, assignment, state.config.recallMaxQueryChars);
	const hits = await searchOwningBank(owner, query);
	if (hits === undefined) return undefined;
	const candidates: DedupeCandidate[] = [];
	const loadLessonHit = (result: RecallResult): DedupeCandidate | undefined => {
		const hit = state.getScopedMemory(result.id);
		if (!hit || hit.invalidated || hit.bank !== owner.bank || hit.store === "fact") return undefined;
		const metadata = parseMetadata(hit.row.metadata);
		const isLesson = isSchemaLesson(metadata)
			? metadata?.[PROJECT_KEY] === projectKey
			: hit.row.memory_type === "lesson";
		return isLesson ? { id: hit.row.id, content: hit.row.content, metadata } : undefined;
	};
	try {
		for (const result of hits) {
			const candidate = loadLessonHit(result);
			if (candidate !== undefined) candidates.push(candidate);
		}
	} catch (error) {
		logger.warn("Experience: dedupe candidate load failed", { bank: owner.bank, error: String(error) });
		return undefined;
	}
	const scanned = scanOwningBank(owner, projectKey);
	if (scanned === undefined) return undefined;
	const known = [...candidates, ...scanned.filter(row => !candidates.some(candidate => candidate.id === row.id))];
	return { candidates, known, scanned };
}

/**
 * Post-extraction duplicate lookup on the lesson's own rendered text, run under the bank lock before the lesson is
 * admitted. The assignment query can surface a differently phrased lesson the assignment search missed, so the owning
 * bank is recalled with the lesson text — native embeddings, enhanced path first — and every lesson hit joins `known`,
 * where the deterministic duplicate check reads it. The complete scanned set already proves what exists, so this only
 * widens the surface; a failed lookup fails the admission closed, and no completion is made.
 */
async function augmentDedupeWithLessonText(
	state: MnemopiSessionState,
	project: ExperienceProjectContext,
	dedupe: DedupeSet,
	lesson: ExperienceLesson,
): Promise<DedupeSet | undefined> {
	const owner = state.getScopedRetainTarget();
	const query = clampText(renderLessonContent(lesson), state.config.recallMaxQueryChars);
	const hits = await searchOwningBank(owner, query);
	if (hits === undefined) return undefined;
	try {
		for (const result of hits) {
			const hit = state.getScopedMemory(result.id);
			if (!hit || hit.invalidated || hit.bank !== owner.bank || hit.store === "fact") continue;
			const metadata = parseMetadata(hit.row.metadata);
			const isLesson = isSchemaLesson(metadata)
				? metadata?.[PROJECT_KEY] === project.projectKey
				: hit.row.memory_type === "lesson";
			if (!isLesson) continue;
			const candidate = { id: hit.row.id, content: hit.row.content, metadata };
			if (!dedupe.known.some(existing => existing.id === candidate.id)) dedupe.known.push(candidate);
		}
	} catch (error) {
		logger.warn("Experience: lesson-text dedupe load failed", { bank: owner.bank, error: String(error) });
		return undefined;
	}
	return dedupe;
}

/**
 * A schema lesson whose stored file fingerprints no longer hold in this repo: its knowledge may be
 * outdated, so recall skips it until it is re-verified, replaced, or refreshed.
 */
function isStaleCandidate(candidate: DedupeCandidate, project: ExperienceProjectContext): boolean {
	if (!isSchemaLesson(candidate.metadata)) return false;
	return !conditionsHold(candidate.metadata, project.repoRoot);
}

/**
 * Live schema lessons whose `exp:supersedes` metadata names `id` or a row that does. An A→B→A revert
 * must not leave the intervening version live beside the restored one, so the repair retires every
 * live row on that chain, transitively.
 */
function supersessionChain(scanned: readonly DedupeCandidate[], id: string): DedupeCandidate[] {
	const seen = new Set<string>([id]);
	const chain: DedupeCandidate[] = [];
	for (let frontier = [id]; frontier.length > 0; ) {
		const next: string[] = [];
		for (const ancestorId of frontier) {
			for (const candidate of scanned) {
			const metadata = candidate.metadata;
			if (metadata === undefined || !isSchemaLesson(metadata) || seen.has(candidate.id)) continue;
			const supersedes = metadata[SUPERSEDES_KEY];
				if (typeof supersedes !== "string" || supersedes !== ancestorId) continue;
				seen.add(candidate.id);
				chain.push(candidate);
				next.push(candidate.id);
			}
		}
		frontier = next;
	}
	return chain;
}
 
 /** Candidates as the extraction sees them. A legacy candidate is unverified: updating one re-verifies the knowledge. */
function renderCandidateDigest(candidates: readonly DedupeCandidate[], project: ExperienceProjectContext): string {
 	if (candidates.length === 0) return "(no existing candidates)";
 	return candidates
 		.map(candidate => {
 			const origin = isSchemaLesson(candidate.metadata) ? "experience" : "legacy";
			const stale = isStaleCandidate(candidate, project) ? "; conditions no longer hold — re-verify or update" : "";
			return `- id=${candidate.id} (${origin}${stale}) ${clampText(candidate.content, MAX_CANDIDATE_CHARS)}`;
 		})
 		.join("\n");
 }

/**
 * The candidate a new lesson duplicates, if any: identical after case and whitespace normalization, or the same claim
 * by token overlap, with schema labels excluded so re-labelled text does not evade the check. Naming the row lets a
 * stale match be refreshed instead of silently suppressed.
 */
function findDuplicateMatch(content: string, candidates: readonly DedupeCandidate[]): DedupeCandidate | undefined {
	const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
	const claim = significantTokens(applicabilityText(content));
	return candidates.find(candidate => {
		if (candidate.content.toLowerCase().replace(/\s+/g, " ").trim() === normalized) return true;
		return tokenJaccard(claim, significantTokens(applicabilityText(candidate.content))) >= DUPLICATE_JACCARD;
	});
}

/** Identical after case and whitespace normalization: the exact-duplicate test shared with the Jaccard check. */
function sameContent(a: string, b: string): boolean {
	return a.toLowerCase().replace(/\s+/g, " ").trim() === b.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whether a legacy update target holds facts this lesson does not. Legacy rows carry no schema, so their content can
 * bundle several unrelated facts. Retiring such a row from an update would delete the other facts outright, so when any
 * legacy fact line survives outside the lesson's claim the update becomes a plain new write: the lesson is admitted, the
 * legacy row stays live with its caveat, and no fact is lost.
 */
function legacyFactsPreserved(legacyContent: string, content: string): boolean {
	const covered = significantTokens(applicabilityText(content));
	return legacyContent
		.split("\n")
		.flatMap(line => (line.trim() === "" ? [] : line.split(/(?<=[.!?])\s+(?=[A-Z])/)))
		.map(fact => fact.trim())
		.filter(fact => fact !== "")
		.every(fact => {
			const factTokens = significantTokens(fact);
			if (factTokens.size === 0) return true;
			return tokenOverlap(factTokens, covered) >= Math.min(factTokens.size, LEGACY_FACT_MIN_OVERLAP);
		});
}

/**
 * A legacy target lacking project metadata is a shared row every project recalls under `global` scoping: superseding it
 * from one project's capture would hide the others' knowledge. Updates may not name such a row.
 */
function legacyUpdateRestricted(state: MnemopiSessionState, target: DedupeCandidate): boolean {
	return state.config.scoping === "global" && target.metadata?.[PROJECT_KEY] === undefined;
}

/** A capture that wrote nothing. `llmCalls` is 1 only when the one completion was attempted. */
function emptyCapture(rejected: string, llmCalls = 0): ExperienceCaptureResult {
	return { written: 0, updated: 0, superseded: 0, rejected, llmCalls, memories: [] };
}

/** The bounded, secret-redacted run context shared by the gates and the extraction prompt. */
interface CaptureContext {
	assignment: string;
	evidence: readonly ExperienceToolEvidence[];
	transcript: string;
	resultText: string;
}

/** A lesson that cleared the deterministic gates: rendered content, safe conditions, and their fingerprints. */
type LessonVetting =
	| { ok: true; content: string; conditions: string[]; fingerprints: Record<string, string | null> | undefined }
	| { ok: false; reason: string };

/**
 * Deterministic gates for one lesson, in order: evidence, secret placeholders, duplicate verdict, condition safety
 * and fingerprints, budgets. Any failure rejects the lesson with its reason; nothing is truncated or repaired.
 */
function vetLesson(
	project: ExperienceProjectContext,
	lesson: ExperienceLesson,
	evidence: readonly ExperienceToolEvidence[],
	status: ExperienceRunStatus,
): LessonVetting {
	const gate = verifyEvidenceGate(lesson, evidence, status);
	if (!gate.ok) return gate;
	if (lessonHasSecretPlaceholder(lesson)) return { ok: false, reason: "secret-placeholder-in-lesson" };
	// A `duplicate` verdict is resolved against the live store in `admitLesson`: a re-verified duplicate of a
	// stale lesson refreshes it, and only a fresh duplicate is rejected here.
	const conditions = sanitizeConditions(lesson.conditions);
	if (!conditions.ok) return { ok: false, reason: conditions.reason };
	let fingerprints: Record<string, string | null> | undefined;
	if (conditions.paths.length > 0) {
		if (project.repoRoot === undefined) return { ok: false, reason: "unfingerprintable-conditions" };
		fingerprints = fingerprintPaths(project.repoRoot, conditions.paths);
		if (Object.values(fingerprints).includes(null)) return { ok: false, reason: "condition-file-missing" };
	}
	const content = renderLessonContent(lesson);
	const overBudget = budgetViolation(lesson, content);
	if (overBudget !== undefined) return { ok: false, reason: overBudget };
	return { ok: true, content, conditions: conditions.paths, fingerprints };
}

/**
 * The extraction prompt reaches the model obfuscated, so a reply may echo a `$$…$$` placeholder back. Persisting one
 * would store an opaque reference to a session secret in the bank, so every lesson text field must be placeholder-free.
 */
function lessonHasSecretPlaceholder(lesson: ExperienceLesson): boolean {
	const fields = [
		lesson.title,
		lesson.situation,
		lesson.problem,
		lesson.rootCause,
		lesson.solution,
		lesson.pitfall,
		lesson.evidence,
		lesson.scope,
		...lesson.conditions,
		...lesson.evidenceRefs,
	];
	return fields.some(field => LESSON_PLACEHOLDER_RE.test(field));
}

/** One lesson's admission: the stored memory and what it replaced, or why it was rejected. */
type LessonOutcome =
	| { ok: true; memory: ExperienceMemoryRef; replaced: "schema" | "legacy" | undefined }
	| { ok: false; reason: string };

/**
 * Admits one lesson. An update retires a candidate the extraction was shown; a new lesson is written unless a live lesson
 * already states the same knowledge. Admitted and retired rows update `dedupe`, so later lessons in the run see them.
 */
function admitLesson(
	input: ExperienceCaptureInput,
	lesson: ExperienceLesson,
	dedupe: DedupeSet,
	evidence: readonly ExperienceToolEvidence[],
): LessonOutcome {
	const { state, project } = input;
	const vetted = vetLesson(project, lesson, evidence, input.status);
	if (!vetted.ok) return vetted;
	const target = resolveUpdateTarget(state, lesson, dedupe, project);
	if (typeof target === "string") return { ok: false, reason: target };
	if (target !== undefined && isStaleCandidate(target, project) && sameContent(vetted.content, target.content)) {
		// Identical re-verified knowledge on a conditioned-out target is a refresh, not a replacement:
		// the row keeps its content and id, and only its metadata and fingerprints are rewritten.
		return refreshStaleLesson(state, target, vetted, lesson, input);
	}
	const others = dedupe.known.filter(candidate => candidate.id !== target?.id);
	if (target === undefined) {
		const match = findDuplicateMatch(vetted.content, others);
		if (match !== undefined) {
			// A re-verified lesson identical to a stale one refreshes that row: new fingerprints and capture stamp,
			// metadata the native duplicate write never updates. Any other live match stays a rejected duplicate.
			if (!isStaleCandidate(match, project)) return { ok: false, reason: "duplicate" };
			const outcome = refreshStaleLesson(state, match, vetted, lesson, input);
			if (outcome.ok) {
				dedupe.known = dedupe.known.map(candidate =>
					candidate.id === match.id ? { ...candidate, content: outcome.memory.content } : candidate,
				);
				dedupe.scanned = dedupe.scanned.map(candidate =>
					candidate.id === match.id ? { ...candidate, content: outcome.memory.content } : candidate,
				);
			}
			return outcome;
		}
	}
	const metadata = buildLessonMetadata(state, project, input, lesson, vetted, target?.id);
	const options: RememberFacadeOptions = {
		source: EXPERIENCE_SOURCE,
		importance: lesson.kind === "solution" ? 0.8 : 0.7,
		metadata,
		scope: "bank",
		extract: false,
		extractEntities: false,
		veracity: "tool",
		memoryType: "lesson",
	};
	let id: string | undefined;
	try {
		id =
			target === undefined
				? writeLiveLesson(state, vetted.content, options, dedupe)
				: replaceLesson(state, target, vetted.content, options, dedupe);
	} catch (error) {
		logger.warn("Experience: lesson write failed", { target: target?.id, error: String(error) });
		return { ok: false, reason: target === undefined ? "write-failed" : "replace-failed" };
	}
	if (id === undefined) return { ok: false, reason: "duplicate" };
	const stored = state.getScopedMemory(id)?.row.content ?? vetted.content;
	if (target !== undefined) {
		dedupe.candidates = dedupe.candidates.filter(candidate => candidate.id !== target.id);
		dedupe.known = dedupe.known.filter(candidate => candidate.id !== target.id);
	}
	dedupe.known.push({ id, content: stored, metadata });
	return {
		ok: true,
		memory: { id, bank: state.getScopedRetainTarget().bank, content: stored },
		replaced: target && (isSchemaLesson(target.metadata) ? "schema" : "legacy"),
	};
}

/** Metadata for a lesson write: schema, provenance, and the fingerprints its recall re-checks. */
function buildLessonMetadata(
	state: MnemopiSessionState,
	project: ExperienceProjectContext,
	input: ExperienceCaptureInput,
	lesson: ExperienceLesson,
	vetted: Extract<LessonVetting, { ok: true }>,
	supersedes: string | undefined,
): Metadata {
	return {
		[SCHEMA_KEY]: SCHEMA_VERSION,
		[PROJECT_KEY]: project.projectKey,
		[AGENT_KEY]: input.agentKind ?? "unknown",
		[KIND_KEY]: lesson.kind,
		[EVIDENCE_KEY]: lesson.evidenceRefs,
		[CONDITIONS_KEY]: vetted.conditions,
		[CAPTURED_KEY]: new Date().toISOString(),
		session_id: state.sessionId,
		...(vetted.fingerprints === undefined ? {} : { [FINGERPRINT_KEY]: vetted.fingerprints }),
		...(project.origin ? { origin: project.origin } : {}),
		...(supersedes === undefined ? {} : { [SUPERSEDES_KEY]: supersedes }),
	};
}

/**
 * Resolves the row an update or re-verified duplicate acts on. An update must name a shown candidate. A `duplicate`
 * verdict converts to a refresh only when it names a stale schema lesson, so a fresh duplicate stays rejected. A legacy
 * target that is unscoped under `global` scoping — shared by every project — or holds facts this lesson would not
 * preserve is never retired: the update falls back to an independent new write, keeping the legacy row live.
 */
function resolveUpdateTarget(
	state: MnemopiSessionState,
	lesson: ExperienceLesson,
	dedupe: DedupeSet,
	project: ExperienceProjectContext,
): DedupeCandidate | undefined | "decision-target-not-owned" | "duplicate" {
	const named =
		lesson.decisionId === null ? undefined : dedupe.candidates.find(candidate => candidate.id === lesson.decisionId);
	if (lesson.decision === "update") {
		if (named === undefined) return "decision-target-not-owned";
		if (legacyUpdateRestricted(state, named)) return undefined;
		if (!isSchemaLesson(named.metadata) && !legacyFactsPreserved(named.content, renderLessonContent(lesson))) {
			return undefined;
		}
		return named;
	}
	if (lesson.decision === "duplicate") {
		if (named === undefined || !isStaleCandidate(named, project)) return "duplicate";
		return named;
	}
	return undefined;
}

/**
 * Refreshes a re-verified stale lesson in one owning-bank transaction. The stale row keeps its id and content but is
 * forgotten and re-inserted so its metadata is rewritten — the native duplicate write never updates metadata — and the
 * write must come back live, or the whole transaction rolls back. No other row is touched: `forgetWorking` scopes the
 * purge to exactly this id.
 */
function refreshStaleLesson(
	state: MnemopiSessionState,
	target: DedupeCandidate,
	vetted: Extract<LessonVetting, { ok: true }>,
	lesson: ExperienceLesson,
	input: ExperienceCaptureInput,
): LessonOutcome {
	const owner = state.getScopedRetainTarget();
	const metadata = buildLessonMetadata(state, input.project, input, lesson, vetted, target.id);
	const options: RememberFacadeOptions = {
		source: EXPERIENCE_SOURCE,
		importance: lesson.kind === "solution" ? 0.8 : 0.7,
		metadata,
		scope: "bank",
		extract: false,
		extractEntities: false,
		veracity: "tool",
		memoryType: "lesson",
	};
	try {
		const id = owner.memory.db.transaction(() => {
			if (!owner.memory.forget(target.id)) throw new Error(`forget did not remove ${target.id}`);
			const written = state.rememberScoped(vetted.content, options);
			const live = liveWriteInOwningBank(owner, written);
			if (live === undefined || live.hiddenBy !== null || live.captured !== metadata[CAPTURED_KEY]) {
				throw new Error("refresh is not a live metadata-fresh row");
			}
			return written;
		})();
		if (id === undefined) return { ok: false, reason: "refresh-failed" };
		return { ok: true, memory: { id, bank: owner.bank, content: vetted.content }, replaced: undefined };
	} catch (error) {
		logger.warn("Experience: stale lesson refresh failed", { target: target.id, error: String(error) });
		return { ok: false, reason: "refresh-failed" };
	}
}

/**
 * A new-lesson write. `remember` returns the old row's id for identical content without un-hiding it, so a hidden
 * result is repaired inside one owning-bank transaction — the hidden row is forgotten, the lesson re-inserted, and
 * the intervening live version retired — and an unrepairable write fails instead of reporting success.
 */
function writeLiveLesson(
	state: MnemopiSessionState,
	content: string,
	options: RememberFacadeOptions,
	dedupe: DedupeSet,
): string {
	const owner = state.getScopedRetainTarget();
	const id = state.rememberScoped(content, options);
	const written = liveWriteInOwningBank(owner, id);
	if (written !== undefined && written.hiddenBy === null && written.captured === options.metadata?.[CAPTURED_KEY]) {
		return id as string;
	}
	return repairHiddenWrite(state, content, options, id as string, written, dedupe.scanned);
}

/**
 * Makes a hidden write hold exactly one live version. `hiddenBy` names the row that superseded the id `remember`
 * returned; that row, and every live schema lesson above it on the same supersession chain, is retired in favor of the
 * re-inserted lesson, all in one transaction so a failure leaves the bank untouched. An A→B→A revert ends with the
 * restored lesson as the one live version. `scanned` is the run's complete live-lesson set, so its absence fails closed.
 */
function repairHiddenWrite(
	state: MnemopiSessionState,
	content: string,
	options: RememberFacadeOptions,
	hiddenId: string,
	hidden: LiveWrite | undefined,
	scanned: readonly DedupeCandidate[],
): string {
	const owner = state.getScopedRetainTarget();
	const supersederId =
		hidden === undefined || hidden.hiddenBy === null || hidden.hiddenBy === "expired" ? undefined : hidden.hiddenBy;
	const retired = supersessionChain(scanned, hiddenId);
	if (supersederId === undefined) {
		// Nothing hides the id except a stale valid_until or an unknown row: the hidden id itself cannot
		// be invalidated back to liveness, so the write fails rather than report a hidden success.
		throw new Error(`write ${hiddenId} is not a live row`);
	}
	const superseder = scanned.find(row => row.id === supersederId);
	if (superseder !== undefined) retired.push(superseder);
	else if (!retired.some(row => row.id === supersederId)) throw new Error(`superseder ${supersederId} not live`);
	return owner.memory.db.transaction(() => {
		if (!owner.memory.forget(hiddenId)) throw new Error(`forget did not remove ${hiddenId}`);
		const id = state.rememberScoped(content, options);
		const written = liveWriteInOwningBank(owner, id);
		if (written === undefined || written.hiddenBy !== null || written.captured !== options.metadata?.[CAPTURED_KEY]) {
			throw new Error("repair is not a live metadata-fresh row");
		}
		for (const row of retired) {
			if (row.id === id) continue;
			if (!owner.memory.beam.invalidate(row.id, id as string)) {
				throw new Error(`invalidate did not retire ${row.id}`);
			}
		}
		return id as string;
	})();
}

/**
 * Writes the replacement and retires its target in one native SQLite transaction, so both land or neither does. Store writes
 * join this transaction: pi-mnemopi's `transaction` helper opens no BEGIN while one is already open. Retirement uses the
 * owning bank's beam, since the state's editor would reach other banks. The write must resolve to a live,
 * metadata-fresh row — a hidden or stale duplicate id rolls the whole replacement back — and the target's supersession
 * chain retires with it, so an A→B→A revert leaves exactly one live version.
 */
function replaceLesson(
	state: MnemopiSessionState,
	target: DedupeCandidate,
	content: string,
	options: RememberFacadeOptions,
	dedupe: DedupeSet,
): string | undefined {
	const owner = state.getScopedRetainTarget();
	return owner.memory.db.transaction(() => {
		const id = state.rememberScoped(content, options);
		if (id === target.id) return undefined;
		const written = liveWriteInOwningBank(owner, id);
		if (written === undefined || written.hiddenBy !== null || written.captured !== options.metadata?.[CAPTURED_KEY]) {
			throw new Error(`replacement ${String(id)} is not a live metadata-fresh row`);
		}
		if (!owner.memory.beam.invalidate(target.id, id)) throw new Error(`invalidate did not retire ${target.id}`);
		for (const row of supersessionChain(dedupe.scanned ?? [], target.id)) {
			if (row.id === id) continue;
			if (!owner.memory.beam.invalidate(row.id, id)) throw new Error(`invalidate did not retire ${row.id}`);
		}
		return id;
	})();
}

/**
 * The run's one extraction completion, then admission of each lesson it returns. Runs under the bank lock. Every lesson passes
 * the same gates again before it is written.
 */
async function admitLessons(input: ExperienceCaptureInput, context: CaptureContext): Promise<ExperienceCaptureResult> {
	const { state, project, signal } = input;
	const dedupe = await collectDedupeSet(state, context.assignment, project.projectKey);
	if (signal?.aborted) return emptyCapture("aborted-run");
	if (dedupe === undefined) return emptyCapture("dedupe-unavailable");
	const rendered = prompt.render(experienceExtractionPrompt, {
		projectKey: project.projectKey,
		status: input.status === "success" ? "success" : "failure",
		assignment: context.assignment,
		resultText: context.resultText,
		transcript: context.transcript,
		evidence: renderEvidenceDigest(context.evidence),
		candidates: renderCandidateDigest(dedupe.candidates, project),
	});
	let reply: string | undefined;
	try {
		reply = await input.completeLlm(rendered, undefined, signal);
	} catch (error) {
		logger.warn("Experience: extraction completion failed", { error: String(error) });
	}
	if (reply === undefined) return emptyCapture("llm-unavailable", 1);
	if (signal?.aborted) return emptyCapture("aborted-run", 1);
	const parsed = parseExtractionReply(reply);
	if (parsed.lessons.length === 0) return emptyCapture(parsed.error ?? "no-lesson", 1);
	const memories: ExperienceMemoryRef[] = [];
	const rejections: string[] = [];
	let written = 0;
	let updated = 0;
	let superseded = 0;
	for (const lesson of parsed.lessons) {
		// Post-extraction duplicate lookup on the lesson's own text: the assignment search can miss a differently
		// phrased existing lesson, so every lesson is checked against native recall hits for its rendered text
		// before admission — real embeddings, deterministic match, no second completion.
		if ((await augmentDedupeWithLessonText(state, project, dedupe, lesson)) === undefined) {
			return emptyCapture("dedupe-unavailable", 1);
		}
		const outcome = admitLesson(input, lesson, dedupe, context.evidence);
		if (!outcome.ok) {
			rejections.push(outcome.reason);
			continue;
		}
		memories.push(outcome.memory);
		if (outcome.replaced === "legacy") {
			updated++;
			continue;
		}
		written++;
		if (outcome.replaced === "schema") superseded++;
	}
	if (written + updated > 0) {
		try {
			await state.getScopedRetainTarget().memory.flushExtractions();
		} catch (error) {
			logger.warn("Experience: embedding drain failed", { error: String(error) });
		}
	}
	return { written, updated, superseded, rejected: rejections.join("; "), llmCalls: 1, memories };
}

/**
 * Captures durable lessons from one finished run. Deterministic gates run first, so a run with no admissible evidence makes no
 * model call. Otherwise exactly one completion is made, and every lesson it returns passes the gates again before it is written.
 */
export async function captureExperience(input: ExperienceCaptureInput): Promise<ExperienceCaptureResult> {
	const { state, status, signal } = input;
	const assignment = input.assignment.trim();
	if (!state.config.experienceEnabled) return emptyCapture("experience-disabled");
	if (status === "aborted" || signal?.aborted) return emptyCapture("aborted-run");
	if (assignment === "") return emptyCapture("no-assignment");
	const entries = input.toolEvidence ?? [];
	const tail = entries.slice(-MAX_EVIDENCE_ENTRIES);
	// The latest check-class entry is the decisive verification: keep it even when the newest window cut it.
	const latestCheck = entries.findLast(isCheckEvidence);
	const bounded = latestCheck && !tail.includes(latestCheck) ? [latestCheck, ...tail.slice(1)] : tail;
	// Credential-shaped tokens are removed before anything reaches the extraction model; state.ts still obfuscates
	// the configured secrets on the outbound prompt, so both layers stay in force.
	const evidence = bounded.map(
		(entry): ExperienceToolEvidence => ({
			...entry,
			...(entry.request === undefined
				? {}
				: { request: redactMemorySecrets(clampText(entry.request, EVIDENCE_REQUEST_HEAD)) }),
			...(entry.output === undefined
				? {}
				: { output: redactMemorySecrets(entry.output.trim().slice(-EVIDENCE_OUTPUT_TAIL)) }),
		}),
	);
	if (evidence.length === 0) return emptyCapture("no-tool-evidence");
	// A check with output proves a solution if it passed, or a negative finding if it failed. Other output proves a negative only on a run that did not succeed.
	const admissible =
		evidence.some(entry => isCheckEvidence(entry) && hasOutput(entry)) ||
		(status !== "success" && evidence.some(hasOutput));
	if (!admissible) return emptyCapture("no-verified-evidence");
	const context: CaptureContext = {
		assignment: redactMemorySecrets(clampText(assignment, MAX_ASSIGNMENT_CHARS)),
		evidence,
		transcript: redactMemorySecrets(buildTranscriptDigest(input.messages)),
		resultText: redactMemorySecrets(clampText(input.resultText ?? "", MAX_RESULT_CHARS)),
	};
	try {
		return await withBankLock(state, signal, () => admitLessons(input, context));
	} catch (error) {
		if (signal?.aborted) return emptyCapture("aborted-run");
		throw error;
	}
}
