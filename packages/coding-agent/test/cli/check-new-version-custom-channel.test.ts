/**
 * Contract: on a custom-channel install the startup version check must return
 * nothing. npm's `latest` is upstream omp, so a notice would tell the user to
 * replace their custom build — and `omp update` would then do it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { checkForNewVersion } from "../../src/main";
import { cfgStartupCheckUpdate, cfgUpdateAuto } from "../../src/modes/settings";

const REAL_BIN = "/home/u/.local/share/omp-custom/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("checkForNewVersion on the custom channel", () => {
	const savedRealBin = process.env.OMP_REAL_BIN;

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedRealBin === undefined) delete process.env.OMP_REAL_BIN;
		else process.env.OMP_REAL_BIN = savedRealBin;
	});

	function stubFetch(): string[] {
		const requests: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput, _init?: FetchInit) => {
				requests.push(String(input));
				return Response.json({ version: "999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return requests;
	}

	it("returns nothing and never asks npm", async () => {
		vi.spyOn(cfgStartupCheckUpdate, "get").mockReturnValue(true);
		vi.spyOn(cfgUpdateAuto, "get").mockReturnValue(true);
		process.env.OMP_REAL_BIN = REAL_BIN;
		const requests = stubFetch();

		await expect(checkForNewVersion("1.0.0")).resolves.toBeUndefined();

		expect(requests).toEqual([]);
	});
});
