import { afterEach, describe, expect, it } from "bun:test";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { STOP_WORDS } from "@oh-my-pi/pi-mnemopi/core/synonyms";

const SHARED_FUNCTION_WORDS_MEMORY =
	"Launcherul omp folosește tmux pentru sesiuni persistente; sweeper-ul de idle închide sesiunile inactive după 30 de minute.";
const KIOSK_MEMORY = "SmartTubeKids kiosk mode requires Device Owner provisioning before the parental lock can start.";
const KIOSK_QUERY = "cum activez modul kiosk pentru aplicația de copii";
const QUERY_TIME = "2026-05-30T12:00:00.000Z";

const beams: BeamMemory[] = [];

function makeBeam(): BeamMemory {
	const beam = new BeamMemory({ sessionId: "romanian-function-words", dbPath: ":memory:" });
	beams.push(beam);
	return beam;
}

afterEach(() => {
	while (beams.length > 0) beams.pop()?.close();
});

function seed(beam: BeamMemory): void {
	for (const content of [SHARED_FUNCTION_WORDS_MEMORY, KIOSK_MEMORY]) {
		beam.remember(content, { source: "imported_fixture", importance: 0.6, scope: "global", veracity: "unknown" });
	}
}

describe("Romanian function words are not lexical recall terms", () => {
	it("returns nothing for function-word-only queries, in diacritic and plain spellings", async () => {
		const beam = makeBeam();
		seed(beam);

		for (const query of ["pentru", "după", "dupa", "de cu"]) {
			const results = await beam.recall(query, 5, { queryTime: QUERY_TIME });
			expect(results.map(result => result.content)).toEqual([]);
		}
	});

	it("gives the kiosk query no keyword hit on the tmux memory", async () => {
		const beam = makeBeam();
		seed(beam);

		const results = await beam.recall(KIOSK_QUERY, 5, { queryTime: QUERY_TIME });
		expect(results.map(result => result.content)).not.toContain(SHARED_FUNCTION_WORDS_MEMORY);
	});

	it("ranks the content match first when the query also contains Romanian function words", async () => {
		const beam = makeBeam();
		seed(beam);

		const results = await beam.recall("kiosk mode pentru de copii", 5, { queryTime: QUERY_TIME });
		expect(results[0]?.content).toBe(KIOSK_MEMORY);
		expect(results.map(result => result.content)).not.toContain(SHARED_FUNCTION_WORDS_MEMORY);
	});

	it("lists Romanian function words in both diacritic and plain forms", () => {
		const forms = [
			["pentru"],
			["după", "dupa"],
			["și", "si"],
			["fără", "fara"],
			["până", "pana"],
			["între", "intre"],
			["către", "catre"],
			["lângă", "langa"],
			["împotriva", "impotriva"],
			["când", "cand"],
			["dacă", "daca"],
			["decât", "decat"],
			["căci", "caci"],
			["îmi", "imi"],
			["îți", "iti"],
			["își", "isi"],
			["ești", "esti"],
			["sunteți", "sunteti"],
			["aveți", "aveti"],
			["aceștia", "acestia"],
			["acești", "acesti"],
		];
		for (const spellings of forms) {
			for (const word of spellings) expect(STOP_WORDS.has(word)).toBe(true);
		}
	});

	it("excludes forms that collide with English words", () => {
		for (const word of ["ai", "al", "un", "e", "ea", "sub", "care", "era", "ma", "ca", "sa"]) {
			expect(STOP_WORDS.has(word)).toBe(false);
		}
	});
});
