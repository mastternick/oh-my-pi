import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { recall } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { currentEmbeddingModel } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { PolyphonicRecallEngine } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";

type TestBeam = BeamMemoryState & { close(): void };

const beams: TestBeam[] = [];

function makeBeam(): TestBeam {
	const db = new Database(":memory:");
	initBeam(db);
	const beam: TestBeam = {
		db,
		sessionId: "s1",
		authorId: null,
		authorType: null,
		channelId: "s1",
		useCloud: false,
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
		close() {
			db.close();
		},
	};
	beams.push(beam);
	return beam;
}

afterEach(() => {
	while (beams.length > 0) beams.pop()?.close();
});

// Unit query vector [1, 0, 0]; a unit row whose raw cosine with it is exactly `cosine`.
const QUERY = [1, 0, 0];
const QUERY_TEXT = "why does the background worker terminate itself?";
const vectorAt = (cosine: number, axis: "y" | "z"): number[] =>
	axis === "y" ? [cosine, Math.sqrt(1 - cosine * cosine), 0] : [cosine, 0, Math.sqrt(1 - cosine * cosine)];

function seedWorking(beam: TestBeam, id: string, content: string, vector: number[], model: string): void {
	beam.db.run(
		"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, scope, veracity, memory_type) VALUES (?, ?, 'test', '2026-05-30T12:00:00.000Z', 's1', 0.5, 'global', 'unknown', 'general')",
		[id, content],
	);
	beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)", [
		id,
		JSON.stringify(vector),
		model,
	]);
}

const recallIds = async (beam: TestBeam, query: string, model: string): Promise<string[]> =>
	(await recall(beam, query, 5, { queryEmbedding: QUERY, queryEmbeddingModel: model })).map(result => result.id);

const voiceIds = (beam: TestBeam, model: string): string[] =>
	new PolyphonicRecallEngine({ db: beam.db })
		.vectorVoice(QUERY, { queryEmbeddingModel: model })
		.map(result => result.memoryId);

// Gold shares no lexical token with the query: only the dense channel can surface it.
const GOLD = "Daemon idle timer fires after silent watchdog expiry.";
const JUNK = "Grocery list: oat milk, eggs, bananas.";

const calibrated = [
	{ model: "nvidia/nemotron-3.5-embed-1b:free", goldCosine: 0.3 },
	{ model: "perplexity/pplx-embed-v1-0.6b", goldCosine: 0.36 },
];

describe("dense-only recall with calibrated per-model floors", () => {
	for (const { model, goldCosine } of calibrated) {
		it(`recalls a semantic-only passage above the floor and drops junk below it (${model})`, async () => {
			const beam = makeBeam();
			seedWorking(beam, "gold", GOLD, vectorAt(goldCosine, "y"), model);
			seedWorking(beam, "junk", JUNK, vectorAt(0.1, "z"), model);
			expect(await recallIds(beam, QUERY_TEXT, model)).toEqual(["gold"]);
		});

		it(`abstains on nonsense when every cosine is below the floor (${model})`, async () => {
			const beam = makeBeam();
			seedWorking(beam, "junk", JUNK, vectorAt(0.1, "z"), model);
			expect(await recallIds(beam, "zxqvplm norfq", model)).toEqual([]);
		});
	}

	it("keeps the 0.65 dense gate for models without a calibrated floor", async () => {
		const beam = makeBeam();
		const model = currentEmbeddingModel();
		seedWorking(beam, "gold", GOLD, vectorAt(0.3, "y"), model);
		expect(await recallIds(beam, QUERY_TEXT, model)).toEqual([]);
	});
});

describe("dense-only polyphonic vector voice with calibrated per-model floors", () => {
	for (const { model, goldCosine } of calibrated) {
		it(`admits a semantic-only passage above the floor and drops junk below it (${model})`, () => {
			const beam = makeBeam();
			seedWorking(beam, "gold", GOLD, vectorAt(goldCosine, "y"), model);
			seedWorking(beam, "junk", JUNK, vectorAt(0.1, "z"), model);
			expect(voiceIds(beam, model)).toEqual(["gold"]);
		});
	}

	it("keeps the 0.65 vector-voice gate for models without a calibrated floor", () => {
		const beam = makeBeam();
		const model = currentEmbeddingModel();
		seedWorking(beam, "gold", GOLD, vectorAt(0.3, "y"), model);
		expect(voiceIds(beam, model)).toEqual([]);
	});
});
