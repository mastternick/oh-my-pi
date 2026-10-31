import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

function antigravityAcct(index: number, fiveH?: number): UsageReport {
	const quota = (windowId: "5h" | "weekly", fraction: number): UsageReport["limits"][number] => ({
		id: `gemini-${windowId}`,
		label: "Gemini",
		scope: { provider: "google-antigravity", accountId: `acct-${index}`, windowId },
		window: {
			id: windowId,
			label: windowId === "5h" ? "5 Hour" : "Weekly",
			durationMs: windowId === "5h" ? 5 * HOUR : 7 * 24 * HOUR,
			resetsAt: NOW + (index + 1) * (windowId === "5h" ? HOUR : 24 * HOUR),
		},
		amount: { unit: "percent", usedFraction: fraction },
		status: fraction >= 1 ? "exhausted" : "ok",
	});
	return {
		provider: "google-antigravity",
		fetchedAt: NOW,
		metadata: { email: `acct-${index}` },
		limits: [quota("weekly", index / 10), ...(fiveH === undefined ? [] : [quota("5h", fiveH)])],
	};
}

function quotaRows(text: string, title: string): { header: string; accounts: string; amounts: string } {
	const lines = text.split("\n");
	const index = lines.findIndex(line => line.includes(title));
	expect(index).toBeGreaterThanOrEqual(0);
	return { header: lines[index]!, accounts: lines[index + 1]!, amounts: lines[index + 2]! };
}

beforeAll(async () => {
	await initTheme();
});

function win(label: string, windowId: string, durationMs: number, frac: number) {
	return {
		id: windowId,
		label,
		scope: { provider: "kimi-code", windowId },
		window: { id: windowId, label, durationMs },
		amount: { unit: "percent", usedFraction: frac },
		status: frac >= 1 ? "exhausted" : frac >= 0.9 ? "warning" : "ok",
	} satisfies UsageReport["limits"][number];
}

function acct(email: string, total: number, fiveH: number): UsageReport {
	return {
		provider: "kimi-code",
		fetchedAt: Date.now(),
		metadata: { email },
		limits: [
			win("Total quota", "usage-window", 7 * 24 * HOUR, total),
			win("5h limit", "rolling-5h", 5 * HOUR, fiveH),
		],
	} satisfies UsageReport;
}

function spendAcct(email: string, used: number, limit?: number): UsageReport {
	const amount =
		limit === undefined
			? ({ used, unit: "usd" } as const)
			: ({
					used,
					unit: "usd",
					limit,
					remaining: Math.max(0, limit - used),
					usedFraction: used / limit,
					remainingFraction: Math.max(0, limit - used) / limit,
				} as const);
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		metadata: { email },
		limits: [
			{
				id: "anthropic:extra",
				label: "Claude Extra Usage",
				scope: { provider: "anthropic", windowId: "extra" },
				amount,
				...(limit === undefined ? {} : { status: "ok" as const }),
			},
		],
	};
}

describe("renderUsageReports multi-account column alignment (#6067)", () => {
	it("keeps account columns in the same order across every window row", () => {
		// Account A: weekly exhausted, 5h free. Account B: weekly light, 5h exhausted.
		// A naive per-window sort by used fraction swaps the columns between rows.
		const reports: UsageReport[] = [acct("alice@example.test", 1.0, 0.0), acct("bob@example.test", 0.2, 1.0)];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 160));
		const lines = text.split("\n");

		const columnOrder = (sectionLabel: string): string[] => {
			const headerIdx = lines.findIndex(l => l.includes(sectionLabel));
			expect(headerIdx).toBeGreaterThanOrEqual(0);
			// The account-label row is the line right after the section header.
			const labelRow = lines[headerIdx + 1];
			return ["alice@example.test", "bob@example.test"].sort((a, b) => labelRow.indexOf(a) - labelRow.indexOf(b));
		};

		const totalOrder = columnOrder("Total quota");
		const fiveHOrder = columnOrder("5h limit");
		expect(fiveHOrder).toEqual(totalOrder);
	});

	it("keeps all-used-only amount cells within four-column narrow widths", () => {
		const reports = [spendAcct("first@example.test", 123.45), spendAcct("second@example.test", 67.89)];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 11));
		const lines = text.split("\n");
		const headerIdx = lines.findIndex(line => line.includes("Claude Extra Usage"));
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		const amountRow = lines[headerIdx + 2]!;
		const cells = amountRow.trim().split(/\s+/);

		expect(cells).toHaveLength(2);
		expect(cells.every(cell => Bun.stringWidth(cell) <= 4)).toBe(true);
		expect(Bun.stringWidth(amountRow)).toBeLessThanOrEqual(11);
	});

	it("keeps mixed capped and used-only amount cells aligned at narrow widths", () => {
		const reports = [spendAcct("capped@example.test", 50, 100), spendAcct("uncapped@example.test", 123.45)];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 20));
		const lines = text.split("\n");
		const headerIdx = lines.findIndex(line => line.includes("Claude Extra Usage"));
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		const labelRow = lines[headerIdx + 1]!;
		const amountRow = lines[headerIdx + 2]!;
		const summaryStart = amountRow.lastIndexOf(" 2 accts");

		expect(summaryStart).toBeGreaterThanOrEqual(0);
		expect(Bun.stringWidth(labelRow)).toBe(11);
		expect(Bun.stringWidth(amountRow.slice(2, summaryStart))).toBe(9);
	});

	it.each([120, 240])("shows six aligned accounts with only one reported short window at width %i", width => {
		const reports = Array.from({ length: 6 }, (_, index) => antigravityAcct(index, index === 3 ? 1 : undefined));
		const before = JSON.stringify(reports);
		const output = stripVTControlCharacters(renderUsageReports(reports, theme, NOW, width));
		const weekly = quotaRows(output, "Gemini (Weekly)");
		const short = quotaRows(output, "Gemini (5 Hour)");
		const order = ["acct-3", "acct-5", "acct-4", "acct-2", "acct-1", "acct-0"];

		expect(short.amounts).toContain("0% free · 1/6 reported");
		expect(short.amounts.match(/not reported/g)).toHaveLength(5);
		expect(short.amounts).not.toContain("100% free");
		expect(weekly.amounts).toContain("75% free");
		expect(weekly.amounts).not.toContain("reported");
		expect(short.accounts.match(/\(4h\)/g)).toHaveLength(1);
		expect(short.accounts).not.toMatch(/\(\d+d\)/);
		expect(output).not.toContain("resets in");
		for (const [index, label] of order.entries()) {
			const start = short.accounts.indexOf(label);
			const end = start + short.accounts.indexOf(order[1]!) - short.accounts.indexOf(order[0]!) - 1;
			expect(start).toBeGreaterThanOrEqual(0);
			expect(start).toBe(weekly.accounts.indexOf(label));
			const cell = short.amounts.slice(start, end).trim();
			if (index === 0) {
				expect(cell).toMatch(/^█+$/);
			} else {
				expect(cell).toStartWith("not reported");
				expect(cell).not.toMatch(/[█░▒▓·]/);
			}
		}
		expect(JSON.stringify(reports)).toBe(before);
	});

	it.each([60, 80])("keeps unknown placeholders explicit without overflowing width %i", width => {
		const reports = Array.from({ length: 6 }, (_, index) => antigravityAcct(index, index === 3 ? 1 : undefined));
		const output = stripVTControlCharacters(renderUsageReports(reports, theme, NOW, width));
		const short = quotaRows(output, "Gemini (5 Hour)");

		expect(short.amounts.match(/\?/g)).toHaveLength(5);
		expect(short.amounts).toContain("0% free · 1/6 reported");
		expect(output.match(/\? = not reported/g)).toHaveLength(1);
		for (const line of output.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps fully reported window percentages, reset columns, and bars aligned", () => {
		const reports = [antigravityAcct(0, 0), antigravityAcct(1, 1)];
		const output = stripVTControlCharacters(renderUsageReports(reports, theme, NOW, 160));
		const short = quotaRows(output, "Gemini (5 Hour)");
		const weekly = quotaRows(output, "Gemini (Weekly)");

		expect(output).not.toContain("not reported");
		expect(output).not.toContain("reported");
		expect(short.accounts).toMatch(/^  acct-1 +\(2h\) +acct-0 +\(1h\)$/);
		expect(weekly.accounts).toMatch(/^  acct-1 +\(2d\) +acct-0 +\(1d\)$/);
		expect(short.amounts).toContain("50% free");
		expect(weekly.amounts).toContain("95% free");
		const secondColumn = short.accounts.indexOf("acct-0");
		expect(secondColumn).toBe(weekly.accounts.indexOf("acct-0"));
		for (const row of [short, weekly]) {
			expect(row.amounts.slice(2, secondColumn).trim()).toMatch(/^[█░▒▓]+$/);
			expect(row.amounts.slice(secondColumn).trim()).toMatch(/^[█░▒▓]+ +\d+% free$/);
		}
	});

	it("keeps sparse Gemini separate from deduplicated Claude and GPT shared counters", () => {
		const reports = Array.from({ length: 6 }, (_, index) => {
			const report = antigravityAcct(index, index === 3 ? 1 : undefined);
			const shared = antigravityAcct(index, 0.25).limits.flatMap(limit =>
				["anthropic", "openai"].map(counter => ({
					...limit,
					id: `${counter}-${limit.window!.id}`,
					label: "Claude & GPT (shared)",
					scope: { ...limit.scope, shared: true, sharedGroup: `3p-${limit.window!.id}` },
					amount: { unit: "percent", usedFraction: 0.25 },
					status: "ok" as const,
				})),
			);
			return { ...report, limits: [...report.limits, ...shared] };
		});
		const output = stripVTControlCharacters(renderUsageReports(reports, theme, NOW, 240));
		const gemini = quotaRows(output, "Gemini (5 Hour)");
		const shared = quotaRows(output, "Claude & GPT (shared) (5 Hour)");

		expect(output.match(/Gemini/g)).toHaveLength(2);
		expect(output.match(/Claude & GPT \(shared\)/g)).toHaveLength(2);
		expect(gemini.amounts).toContain("0% free · 1/6 reported");
		expect(shared.amounts).toContain("75% free");
		expect(shared.amounts).not.toContain("reported");
		expect(shared.accounts.match(/acct-\d/g)).toHaveLength(6);
		expect(gemini.amounts.match(/not reported/g)).toHaveLength(5);
		expect(shared.amounts).not.toContain("not reported");
		for (const label of ["acct-3", "acct-5", "acct-4", "acct-2", "acct-1", "acct-0"]) {
			expect(shared.accounts.indexOf(label)).toBe(gemini.accounts.indexOf(label));
		}
	});

	it("keeps zero-limit accounts out of the not-reported columns and coverage counts", () => {
		const reports: UsageReport[] = [
			antigravityAcct(0, 0.5),
			{ provider: "google-antigravity", fetchedAt: NOW, metadata: { email: "zero-limit" }, limits: [] },
		];
		const output = stripVTControlCharacters(renderUsageReports(reports, theme, NOW, 160));
		const short = quotaRows(output, "Gemini (5 Hour)");

		expect(short.amounts).toContain("50% free");
		expect(output).not.toContain("not reported");
		expect(output).not.toContain("reported");
		expect(short.accounts).not.toContain("zero-limit");
		expect(output.match(/zero-limit -- no limits/g)).toHaveLength(1);
	});
});
