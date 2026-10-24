/**
 * Ordered embedding-model chain: primary first, then fallbacks. Covers chain
 * resolution, query-time fallback with cooldown, model-keyed `memory_embeddings`
 * migration, and per-model reconcile on store open.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { embeddingChain, embedQuery, resetEmbeddingStateForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { embeddingFallbackModels, parseModelList } from "../src/config";

const PRIMARY = "nvidia/nemotron-3.5-embed-1b:free";
const FALLBACK = "nvidia/nemotron-3-embed-1b:free";
const PPLX = "perplexity/pplx-embed-v1-0.6b";
const STALE = "stale/retired-model";
const API_URL = "https://openrouter.test/api/v1";
const COOLDOWN_MS = 5 * 60 * 1000;

const ENV_KEYS = [
	"MNEMOPI_NO_EMBEDDINGS",
	"MNEMOPI_EMBEDDING_MODEL",
	"MNEMOPI_EMBEDDING_FALLBACK_MODELS",
	"MNEMOPI_EMBEDDING_API_KEY",
	"MNEMOPI_EMBEDDING_API_URL",
	"MNEMOPI_EMBEDDINGS_VIA_API",
	"OPENROUTER_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_BASE_URL",
] as const;

const savedEnv = new Map<string, string | undefined>();
let requestedModels: string[] = [];
const originalFetch = globalThis.fetch;

type Reply = { status: number; embedding?: number[] };

/** Routes each OpenRouter embeddings request by `body.model`; unlisted models get 404. */
function stubFetch(replies: Record<string, Reply>): void {
	requestedModels = [];
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { model: string };
		requestedModels.push(body.model);
		const reply = replies[body.model];
		if (reply?.status === 200) {
			return new Response(JSON.stringify({ data: [{ embedding: reply.embedding }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("upstream", { status: reply?.status ?? 404 });
	}) as typeof fetch;
}

function apiMemory(fallbackModels?: string[], model: string = PRIMARY): Mnemopi {
	return new Mnemopi({
		db: new Database(":memory:"),
		embeddings: { model, apiKey: "test-key", apiUrl: API_URL, fallbackModels },
	});
}

function fakeEmbed() {
	return async function* embed(texts: readonly string[]) {
		yield texts.map(() => [0.1, 0.2, 0.3, 0.4]);
	};
}

beforeEach(() => {
	savedEnv.clear();
	for (const key of ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
	resetEmbeddingStateForTests();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetEmbeddingStateForTests();
	requestedModels = [];
});

describe("embedding chain config", () => {
	it("keeps the primary first and de-duplicates fallbacks in order", () => {
		const memory = apiMemory([FALLBACK, PRIMARY, PPLX, FALLBACK, ""]);
		try {
			const chain = withMnemopiRuntimeOptions(memory.runtimeOptions, () => embeddingChain());
			expect(chain).toEqual([PRIMARY, FALLBACK, PPLX]);
		} finally {
			memory.close();
		}
	});

	it("keeps the single-model chain when no fallbacks are configured", () => {
		const memory = apiMemory([]);
		try {
			expect(withMnemopiRuntimeOptions(memory.runtimeOptions, () => embeddingChain())).toEqual([PRIMARY]);
		} finally {
			memory.close();
		}
	});

	it("reads the MNEMOPI_EMBEDDING_FALLBACK_MODELS env twin when no runtime list is set", () => {
		process.env.MNEMOPI_EMBEDDING_MODEL = PRIMARY;
		process.env.MNEMOPI_EMBEDDING_FALLBACK_MODELS = `${FALLBACK}, ,${PPLX}`;
		expect(embeddingChain()).toEqual([PRIMARY, FALLBACK, PPLX]);
	});

	it("parses comma-separated model lists, trimming and dropping empties", () => {
		expect(parseModelList(" a, ,b ,, c ")).toEqual(["a", "b", "c"]);
		expect(parseModelList("")).toEqual([]);
		expect(embeddingFallbackModels({ MNEMOPI_EMBEDDING_FALLBACK_MODELS: ` ${FALLBACK} ,${PPLX}` })).toEqual([
			FALLBACK,
			PPLX,
		]);
		expect(embeddingFallbackModels({})).toEqual([]);
	});
});

describe("query embedding fallback", () => {
	it("falls back to the next chain model when the primary endpoint fails", async () => {
		stubFetch({ [PRIMARY]: { status: 504 }, [FALLBACK]: { status: 200, embedding: [0.1, 0.2, 0.3, 0.4] } });
		const memory = apiMemory([FALLBACK, PPLX]);
		try {
			const result = await withMnemopiRuntimeOptions(memory.runtimeOptions, () => embedQuery("fallback query"));
			expect(result?.model).toBe(FALLBACK);
			expect(result?.vector.length).toBe(4);
			expect(requestedModels).toEqual([PRIMARY, FALLBACK]);
		} finally {
			memory.close();
		}
	});

	it("returns null when every chain model fails", async () => {
		stubFetch({ [PRIMARY]: { status: 504 }, [FALLBACK]: { status: 503 } });
		const memory = apiMemory([FALLBACK]);
		try {
			expect(await withMnemopiRuntimeOptions(memory.runtimeOptions, () => embedQuery("nothing works"))).toBeNull();
			expect(requestedModels).toEqual([PRIMARY, FALLBACK]);
		} finally {
			memory.close();
		}
	});

	it("skips a cooled-down primary until the cooldown expires", async () => {
		const clock = spyOn(Date, "now");
		const base = 1_700_000_000_000;
		clock.mockReturnValue(base);
		stubFetch({ [PRIMARY]: { status: 504 }, [FALLBACK]: { status: 200, embedding: [1, 0, 0, 0] } });
		const memory = apiMemory([FALLBACK]);
		try {
			const run = (text: string) => withMnemopiRuntimeOptions(memory.runtimeOptions, () => embedQuery(text));

			expect((await run("first"))?.model).toBe(FALLBACK);
			expect(requestedModels).toEqual([PRIMARY, FALLBACK]);

			requestedModels = [];
			expect((await run("second"))?.model).toBe(FALLBACK);
			expect(requestedModels).toEqual([FALLBACK]);

			stubFetch({
				[PRIMARY]: { status: 200, embedding: [0, 1, 0, 0] },
				[FALLBACK]: { status: 200, embedding: [1, 0, 0, 0] },
			});
			clock.mockReturnValue(base + COOLDOWN_MS + 1);
			expect((await run("third"))?.model).toBe(PRIMARY);
		} finally {
			memory.close();
			clock.mockRestore();
		}
	});

	it("does not let a failure in one runtime cool down the model for another", async () => {
		const bare = new Mnemopi({ db: new Database(":memory:"), embeddings: { model: PRIMARY } });
		try {
			expect(await withMnemopiRuntimeOptions(bare.runtimeOptions, () => embedQuery("shared text"))).toBeNull();
		} finally {
			bare.close();
		}

		stubFetch({ [PRIMARY]: { status: 200, embedding: [0.5, 0.5, 0, 0] } });
		const memory = apiMemory([]);
		try {
			expect((await withMnemopiRuntimeOptions(memory.runtimeOptions, () => embedQuery("shared text")))?.model).toBe(
				PRIMARY,
			);
		} finally {
			memory.close();
		}
	});
});

describe("memory_embeddings keyed by (memory_id, model)", () => {
	it("migrates a legacy single-key table, keeping rows and tolerating a second init", () => {
		const db = new Database(":memory:");
		db.run(
			"CREATE TABLE memory_embeddings (memory_id TEXT PRIMARY KEY, embedding_json TEXT, model TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
		);
		db.run(
			"INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES ('m1', '[1,0]', 'old-model'), ('m2', '[0,1]', NULL)",
		);

		initBeam(db);
		initBeam(db);

		const rows = db.query("SELECT memory_id, model FROM memory_embeddings ORDER BY memory_id").all();
		expect(rows).toEqual([
			{ memory_id: "m1", model: "old-model" },
			{ memory_id: "m2", model: "" },
		]);
		const pk = (db.query("PRAGMA table_info(memory_embeddings)").all() as { name: string; pk: number }[])
			.filter(column => column.pk > 0)
			.map(column => column.name)
			.sort();
		expect(pk).toEqual(["memory_id", "model"]);

		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES ('m1', '[0,1]', 'new-model')");
		const m1Count = db.query("SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id = 'm1'").get() as {
			n: number;
		};
		expect(m1Count.n).toBe(2);
		db.close();
	});
});

function seedChainDb(rows: Array<[string, string]>, storedPrimary?: string): Database {
	const db = new Database(":memory:");
	initBeam(db);
	const ts = new Date().toISOString();
	db.prepare(
		"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
	).run("wm-1", "alpha working memory", ts);
	db.prepare(
		"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, binary_vector) VALUES (?, ?, 'test', ?, 'default', ?)",
	).run("ep-1", "beta episodic memory", ts, new Uint8Array([1, 2, 3, 4]));
	for (const [id, model] of rows) {
		db.prepare("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)").run(
			id,
			JSON.stringify([1, 0, 0, 0]),
			model,
		);
	}
	if (storedPrimary !== undefined) {
		db.prepare("INSERT INTO mnemopi_meta (key, value) VALUES ('embedding_primary_model', ?)").run(storedPrimary);
	}
	return db;
}

function embeddingRows(memory: Mnemopi): string[] {
	return (
		memory.conn.query("SELECT memory_id || '|' || model AS k FROM memory_embeddings ORDER BY k").all() as {
			k: string;
		}[]
	).map(row => row.k);
}

function episodicBinary(memory: Mnemopi): Uint8Array | null {
	const row = memory.conn.query("SELECT binary_vector AS v FROM episodic_memory WHERE id = 'ep-1'").get() as {
		v: Uint8Array | null;
	};
	return row.v;
}

describe("reconcile across the embedding chain", () => {
	it("drops rows outside the chain, keeps chain rows and binary vectors when the primary is unchanged", async () => {
		const db = seedChainDb(
			[
				["wm-1", PRIMARY],
				["ep-1", PRIMARY],
				["ep-1", FALLBACK],
				["wm-1", STALE],
			],
			PRIMARY,
		);
		const memory = new Mnemopi({
			db,
			embeddings: { model: PRIMARY, fallbackModels: [FALLBACK], provider: fakeEmbed() },
		});
		try {
			expect(embeddingRows(memory)).toEqual([`ep-1|${FALLBACK}`, `ep-1|${PRIMARY}`, `wm-1|${PRIMARY}`]);
			expect(episodicBinary(memory)).toEqual(new Uint8Array([1, 2, 3, 4]));

			await memory.flushExtractions();
			expect(embeddingRows(memory)).toEqual([
				`ep-1|${FALLBACK}`,
				`ep-1|${PRIMARY}`,
				`wm-1|${FALLBACK}`,
				`wm-1|${PRIMARY}`,
			]);
		} finally {
			memory.close();
			db.close();
		}
	});

	it("clears binary vectors only when the primary changed, keeping the old primary's chain rows", async () => {
		const db = seedChainDb([["ep-1", PRIMARY]], PRIMARY);
		const memory = new Mnemopi({
			db,
			embeddings: { model: FALLBACK, fallbackModels: [PRIMARY], provider: fakeEmbed() },
		});
		try {
			expect(episodicBinary(memory)).toBeNull();
			expect(embeddingRows(memory)).toEqual([`ep-1|${PRIMARY}`]);

			await memory.flushExtractions();
			expect(embeddingRows(memory)).toEqual([
				`ep-1|${FALLBACK}`,
				`ep-1|${PRIMARY}`,
				`wm-1|${FALLBACK}`,
				`wm-1|${PRIMARY}`,
			]);
		} finally {
			memory.close();
			db.close();
		}
	});
});
