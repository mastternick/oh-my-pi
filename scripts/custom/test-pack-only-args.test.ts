import { describe, expect, it } from "bun:test";
import { packOnlyDirFromArgs } from "../ci-release-publish";

describe("pack-only argument", () => {
	it("reads the output directory from either flag form", () => {
		expect(packOnlyDirFromArgs(["--pack-only", "/tmp/out"])).toBe("/tmp/out");
		expect(packOnlyDirFromArgs(["--pack-only=/tmp/out"])).toBe("/tmp/out");
		expect(packOnlyDirFromArgs([])).toBeNull();
	});

	it("rejects a flag without a directory", () => {
		expect(() => packOnlyDirFromArgs(["--pack-only"])).toThrow("--pack-only requires an output directory");
	});
});
