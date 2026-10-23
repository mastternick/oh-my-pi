import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import {
	callBash,
	CMD,
	flatten,
	installExtractor,
	Lab,
	LESSON_PREFIX,
	lessonReply,
	NO_LESSONS,
	parserSolution,
	ref,
	say,
} from "./support.ts";

const TASK = "Fix the parser empty input crash so sh verify.sh passes.";
const TITLE = "Parser empty input crash";

/** Bash-only TASK worker. No `spawns`, so the task tool is not added to the child's toolset. */
const WORKER: AgentDefinition = {
	name: "task",
	description: "Fixes the parser and runs its check",
	systemPrompt: "Fix the assigned task with bash. Reply done once the check passes.",
	tools: ["bash"],
	source: "bundled",
};

describe("C: worker learning", () => {
	let lab: Lab;
	beforeEach(() => {
		lab = new Lab();
	});
	afterEach(() => lab.close());

	it("C: a settled TASK worker writes exactly one lesson, and a later worker in the repo receives it", async () => {
		const repo = lab.fixture("parser");
		const parent = await lab.session({ cwd: repo, responses: ["ok"] });
		installExtractor(evidence =>
			evidence.some(entry => entry.ok && entry.request.includes(CMD.verify))
				? lessonReply(parserSolution([ref(evidence, CMD.verify, true)]))
				: NO_LESSONS,
		);

		// runSubprocess has no streamFn option, so the child's streamSimple call is routed to the mock.
		const first = createMockModel({
			responses: [callBash(CMD.verify), callBash(CMD.fix), callBash(CMD.verify), say("done")],
		});
		const second = createMockModel({ responses: [say("done")] });
		const streams = spyOn(ai, "streamSimple").mockImplementation(first.stream);

		const shared = {
			cwd: repo,
			agent: WORKER,
			task: TASK,
			modelOverride: `${lab.model.provider}/${lab.model.id}`,
			modelRegistry: parent.session.modelRegistry,
			settings: parent.settings,
			parentMnemopiSessionState: getMnemopiSessionState(parent.session),
			structured: false,
			enableLsp: false,
			enableIrc: false,
			keepAlive: false,
		};

		const firstRun = await runSubprocess({ ...shared, index: 0, id: "C-worker-1" });
		expect(firstRun.exitCode).toBe(0);
		const afterFirst = lab.currentLessons(lab.dbPaths(parent.session));
		expect(afterFirst).toHaveLength(1);
		expect(afterFirst[0]?.content).toContain(LESSON_PREFIX);
		expect(afterFirst[0]?.content).toContain(TITLE);

		streams.mockImplementation(second.stream);
		const secondRun = await runSubprocess({ ...shared, index: 1, id: "C-worker-2" });
		expect(secondRun.exitCode).toBe(0);
		expect(second.calls).not.toHaveLength(0);
		expect(flatten(second.calls[0]?.context)).toContain(TITLE);
		expect(lab.currentLessons(lab.dbPaths(parent.session))).toHaveLength(1);
	});
});
