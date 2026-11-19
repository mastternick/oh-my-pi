/**
 * Contract: the custom channel is recognised from its own markers, never from a
 * version string — the startup notice and `omp update` must not treat it as an
 * npm install of upstream omp.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	CUSTOM_UPDATER_ENV,
	customInstallRoot,
	customUpdaterPath,
	isCustomChannelInstall,
	isCustomChannelPath,
} from "../../src/cli/custom-channel";

const REAL_BIN = "/home/u/.local/share/omp-custom/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
// What Bun's realpath of that symlink yields: the versioned tree, no `current`.
const VERSIONED_BIN =
	"/home/u/.local/share/omp-custom/versions/19.0.0-c1/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";
// The installed entrypoint: a link chain to the launcher, outside the install tree.
const LAUNCHER = "/home/u/.local/share/omp-launcher/bin/omp";

describe("isCustomChannelPath", () => {
	it("matches the install's current tree", () => {
		expect(isCustomChannelPath(REAL_BIN)).toBe(true);
		expect(isCustomChannelPath("/home/u/.local/share/omp-custom/current")).toBe(true);
	});

	it("matches the versioned tree Bun resolves current to", () => {
		expect(isCustomChannelPath(VERSIONED_BIN)).toBe(true);
		expect(isCustomChannelPath("/home/u/.local/share/omp-custom/versions/19.0.0-c1")).toBe(true);
	});

	it("matches Windows separators", () => {
		expect(isCustomChannelPath("C:\\Users\\u\\AppData\\Local\\omp-custom\\current\\cli.js")).toBe(true);
		expect(isCustomChannelPath("C:\\Users\\u\\AppData\\Local\\omp-custom\\versions\\19.0.0-c1\\cli.js")).toBe(true);
	});

	it("rejects npm, standalone, and source-checkout paths", () => {
		expect(isCustomChannelPath("/home/u/.bun/bin/omp")).toBe(false);
		expect(
			isCustomChannelPath("/home/u/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"),
		).toBe(false);
		expect(isCustomChannelPath("/usr/local/bin/omp")).toBe(false);
		expect(isCustomChannelPath("/home/u/DEV/oh-my-pi/packages/coding-agent/src/cli")).toBe(false);
		expect(isCustomChannelPath("/home/u/DEV/oh-my-pi-custom/packages/coding-agent/src/cli")).toBe(false);
		expect(isCustomChannelPath("/home/u/DEV/oh-my-pi-custom-auto/packages/coding-agent/dist/cli.js")).toBe(false);
		expect(isCustomChannelPath(undefined)).toBe(false);
	});
});

describe("isCustomChannelInstall", () => {
	it("detects an explicitly exported OMP_REAL_BIN marker", () => {
		// Only a fresh-install launcher exports it; production is covered by the layout test below.
		expect(isCustomChannelInstall({ env: { OMP_REAL_BIN: REAL_BIN }, modulePath: "" })).toBe(true);
	});

	it("detects a build started from the install tree without the marker", () => {
		expect(isCustomChannelInstall({ env: {}, ompPath: REAL_BIN })).toBe(true);
		expect(isCustomChannelInstall({ env: {}, modulePath: path.dirname(REAL_BIN) })).toBe(true);
	});

	it("detects the real install: launcher symlink on PATH, versioned module dir", () => {
		expect(isCustomChannelInstall({ env: {}, ompPath: LAUNCHER, modulePath: path.dirname(VERSIONED_BIN) })).toBe(
			true,
		);
	});

	it("stays off for upstream installs", () => {
		expect(
			isCustomChannelInstall({
				env: {},
				ompPath: "/home/u/.bun/bin/omp",
				modulePath: "/home/u/DEV/oh-my-pi/packages/coding-agent/src/cli",
			}),
		).toBe(false);
		expect(
			isCustomChannelInstall({
				env: {},
				ompPath: "/usr/local/bin/omp",
				modulePath: "/home/u/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist",
			}),
		).toBe(false);
	});
});

describe("custom install paths", () => {
	it("resolves the install root from OMP_CUSTOM_HOME, XDG_DATA_HOME, then HOME", () => {
		expect(customInstallRoot({ OMP_CUSTOM_HOME: "/opt/omp", XDG_DATA_HOME: "/xdg", HOME: "/home/u" })).toBe(
			"/opt/omp",
		);
		expect(customInstallRoot({ XDG_DATA_HOME: "/xdg", HOME: "/home/u" })).toBe(path.join("/xdg", "omp-custom"));
		expect(customInstallRoot({ HOME: "/home/u" })).toBe(path.join("/home/u", ".local", "share", "omp-custom"));
	});

	it("resolves the deployed updater from OMP_DAILY_UPDATE_SH, then HOME", () => {
		expect(customUpdaterPath({ [CUSTOM_UPDATER_ENV]: "/opt/upd.sh", HOME: "/home/u" })).toBe("/opt/upd.sh");
		expect(customUpdaterPath({ HOME: "/home/u" })).toBe(path.join("/home/u", ".local", "bin", "omp-daily-update.sh"));
	});
});
