/**
 * Stage-2 verdict for the stall guard: asks the judge role whether a suspected
 * subagent is progressing, looping, or blocked. Every failure path returns
 * `undefined` so the guard fails open.
 */
import { type ChoiceQuestion, type Judge, judgeQuestions, type Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { journalJudgmentUsage, type JudgmentUsageLedger, resolveJudge } from "../judgment";
import questionFile from "../prompts/judge/task-stall.json" with { type: "json" };
import type { StallEvidence, StallVerdict } from "./stall-guard";

const QUESTION: ChoiceQuestion<StallVerdict> = judgeQuestions(questionFile).stall as ChoiceQuestion<StallVerdict>;

/** Answers below this confidence are treated as no verdict. */
export const STALL_JUDGE_MIN_CONFIDENCE = 0.6;
/** Bound on one judge call, so a hung backend cannot hold a suspicion open. */
export const STALL_JUDGE_TIMEOUT_MS = 60_000;
/** Assignment text sent to the judge. */
const ASSIGNMENT_CHARS = 600;

/** Asks for a verdict on one suspicion. Resolves `undefined` when no verdict is available or the signal aborts first. */
export type StallJudge = (
	evidence: StallEvidence,
	assignment: string,
	signal?: AbortSignal,
) => Promise<StallVerdict | undefined>;

/** Ask a judge for a verdict on one suspicion. Errors, cancellation, and low confidence return `undefined`. */
export async function judgeStall(
	judge: Judge,
	evidence: StallEvidence,
	assignment: string,
	signal?: AbortSignal,
): Promise<StallVerdict | undefined> {
	const timeout = AbortSignal.timeout(STALL_JUDGE_TIMEOUT_MS);
	try {
		const { answers } = await judge.judge(
			{
				state: {
					assignment: assignment.slice(0, ASSIGNMENT_CHARS),
					requests: evidence.requests,
					compactions: evidence.compactions,
					repeats: evidence.repeats,
					outputTokens: evidence.outputTokens,
					restatesBlocker: evidence.restatesBlocker,
					recentCalls: [...evidence.calls],
				},
				questions: { stall: QUESTION },
			},
			{ signal: AbortSignal.any(signal ? [signal, timeout] : [timeout]) },
		);
		const answer = answers.stall;
		if (!answer || answer.confidence < STALL_JUDGE_MIN_CONFIDENCE) return undefined;
		return answer.choice;
	} catch (error) {
		// Canceled by the caller (window reset or run end): no answer, nothing to warn about.
		if (signal?.aborted) return undefined;
		logger.warn("Subagent stall judge failed; no action taken", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/** Production judge: the judge role chain, usage journaled to the subagent session. */
export function createRoleStallJudge(deps: {
	settings: Settings;
	registry: ModelRegistry;
	sessionModel?: Model;
	sessionManager?: Partial<JudgmentUsageLedger>;
}): StallJudge {
	const judge = resolveJudge({
		settings: deps.settings,
		registry: deps.registry,
		sessionModel: deps.sessionModel,
		purpose: "task-stall-judge",
		onUsage: journalJudgmentUsage(deps.sessionManager),
	});
	return (evidence, assignment, signal) => judgeStall(judge, evidence, assignment, signal);
}
