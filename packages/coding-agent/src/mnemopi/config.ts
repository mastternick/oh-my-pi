import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MnemopiOptions } from "@oh-my-pi/pi-mnemopi";
import { getMemoriesDir, logger, withLoopPhase } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

import {
	limitBankName,
	PROJECT_IDENTITY_METADATA_KEY,
	projectIdentityBankSegment,
	resolveProjectIdentity,
	resolveProjectRepoRoot,
	sanitizeBankName,
	type ProjectIdentity,
} from "./project-identity";

import {
	cfgMnemopiAutoRecall,
	cfgMnemopiAutoRetain,
	cfgMnemopiBank,
	cfgMnemopiDbPath,
	cfgMnemopiDebug,
	cfgMnemopiEmbeddingApiKey,
	cfgMnemopiEmbeddingApiUrl,
	cfgMnemopiEmbeddingModel,
	cfgMnemopiEmbeddingVariant,
	cfgMnemopiEnhancedRecall,
	cfgMnemopiExperienceEnabled,
	cfgMnemopiInjectionTokenLimit,
	cfgMnemopiLlmApiKey,
	cfgMnemopiLlmBaseUrl,
	cfgMnemopiLlmMode,
	cfgMnemopiLlmModel,
	cfgMnemopiNoEmbeddings,
	cfgMnemopiPolyphonicRecall,
	cfgMnemopiProactiveLinking,
	cfgMnemopiRecallContextTurns,
	cfgMnemopiRecallLimit,
	cfgMnemopiRecallMaxQueryChars,
	cfgMnemopiRetainEveryNTurns,
	cfgMnemopiScoping,
} from "./settings";

export type MnemopiLlmMode = "none" | "smol" | "remote";

export type MnemopiScoping = "global" | "per-project" | "per-project-tagged";

export type MnemopiProviderOptions = Pick<
	MnemopiOptions,
	"noEmbeddings" | "embeddingModel" | "embeddingApiUrl" | "embeddingApiKey" | "llm" | "debug"
>;

export interface MnemopiBackendConfig {
	dbPath: string;
	baseBank?: string;
	bank: string;
	globalBank?: string;
	retainBank?: string;
	recallBanks?: readonly string[];
	scoping?: MnemopiScoping;
	/** Legacy first-turn transcript recall switch; semantics unchanged, value from settings. */
	autoRecall: boolean;
	autoRetain: boolean;
	/** Experience-memory switch: assignment recall + verified lesson capture, independent of autoRecall/autoRetain. */
	experienceEnabled: boolean;
	/** Logical project identity for the session cwd (clone/worktree stable; see project-identity.ts). */
	projectIdentity: ProjectIdentity;
	/** Root for repo-relative lesson fingerprints: git worktree root, else canonical cwd. */
	repoRoot: string;
	polyphonicRecall: boolean;
	enhancedRecall: boolean;
	proactiveLinking: boolean;
	retainEveryNTurns: number;
	recallLimit: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	injectionTokenLimit: number;
	debug: boolean;
	providerOptions: MnemopiProviderOptions;
	llmMode: MnemopiLlmMode;
	llmBaseUrl?: string;
	llmApiKey?: string;
	llmModel?: string;
}

export function loadMnemopiConfig(settings: Settings, agentDir: string): MnemopiBackendConfig {
	const configuredDbPath = cfgMnemopiDbPath.get(settings);
	const cwd = settings.getCwd();
	const scoping = cfgMnemopiScoping.get(settings);
	const dbPath = configuredDbPath?.trim()
		? configuredDbPath
		: path.join(getMemoriesDir(agentDir), "mnemopi", "mnemopi.db");
	const projectIdentity = resolveProjectIdentity(cwd);
	const repoRoot = resolveProjectRepoRoot(cwd);
	const scope = computeMnemopiBankScope(cfgMnemopiBank.get(settings), cwd, scoping, {
		identity: projectIdentity,
		dbPath,
	});
	const recallBanks =
		scoping === "global" ? scope.recallBanks : extendRecallWithLegacyBanks(scope.recallBanks, dbPath, cwd);
	const llmMode = cfgMnemopiLlmMode.get(settings);
	const embeddingOverride = cfgMnemopiEmbeddingModel.get(settings);
	const embeddingVariant = cfgMnemopiEmbeddingVariant.get(settings);
	// Map the variant explicitly rather than indexing an object with the raw config
	// value (which could resolve an inherited property like `__proto__`); any value
	// other than the multilingual variant falls back to the English default.
	const variantModel =
		embeddingVariant === "multilingual" ? "intfloat/multilingual-e5-large" : "BAAI/bge-base-en-v1.5";
	const embeddingModel = embeddingOverride?.trim() || variantModel;
	return {
		dbPath,
		baseBank: scope.baseBank,
		bank: scope.bank,
		globalBank: scope.globalBank,
		retainBank: scope.retainBank,
		recallBanks,
		scoping,
		autoRecall: cfgMnemopiAutoRecall.get(settings),
		experienceEnabled: cfgMnemopiExperienceEnabled.get(settings),
		projectIdentity,
		repoRoot,
		autoRetain: cfgMnemopiAutoRetain.get(settings),
		polyphonicRecall: cfgMnemopiPolyphonicRecall.get(settings),
		enhancedRecall: cfgMnemopiEnhancedRecall.get(settings),
		proactiveLinking: cfgMnemopiProactiveLinking.get(settings),
		retainEveryNTurns: Math.max(1, Math.floor(cfgMnemopiRetainEveryNTurns.get(settings))),
		recallLimit: Math.max(1, Math.floor(cfgMnemopiRecallLimit.get(settings))),
		recallContextTurns: Math.max(1, Math.floor(cfgMnemopiRecallContextTurns.get(settings))),
		recallMaxQueryChars: Math.max(256, Math.floor(cfgMnemopiRecallMaxQueryChars.get(settings))),
		injectionTokenLimit: Math.max(256, Math.floor(cfgMnemopiInjectionTokenLimit.get(settings))),
		debug: cfgMnemopiDebug.get(settings),
		providerOptions: {
			noEmbeddings: cfgMnemopiNoEmbeddings.get(settings),
			debug: cfgMnemopiDebug.get(settings),
			embeddingModel,
			embeddingApiUrl: cfgMnemopiEmbeddingApiUrl.get(settings),
			embeddingApiKey: cfgMnemopiEmbeddingApiKey.get(settings),
			llm:
				llmMode === "remote"
					? {
							baseUrl: cfgMnemopiLlmBaseUrl.get(settings),
							apiKey: cfgMnemopiLlmApiKey.get(settings),
							model: cfgMnemopiLlmModel.get(settings),
						}
					: false,
		},
		llmMode,
		llmBaseUrl: cfgMnemopiLlmBaseUrl.get(settings),
		llmApiKey: cfgMnemopiLlmApiKey.get(settings),
		llmModel: cfgMnemopiLlmModel.get(settings),
	};
}

const DEFAULT_SHARED_BANK = "default";

// Cap legacy-bank scanning at session start so a pathological banks/
// directory cannot dominate startup latency.
const LEGACY_BANK_SCAN_LIMIT = 64;

export interface MnemopiBankScope {
	baseBank: string;
	bank: string;
	globalBank: string;
	retainBank: string;
	recallBanks: readonly string[];
}

/**
 * Resolve write/recall banks for a session.
 *
 * Mnemopi has no tag-filtered recall, so `per-project-tagged` maps to a
 * project-local write bank plus a shared recall-visible bank. The project
 * bank is derived purely from {@link cwd} — see {@link projectBank} for the
 * stability contract.
 */
export function computeMnemopiBankScope(
	configured: string | undefined,
	cwd: string,
	scoping: MnemopiScoping,
	options?: ProjectBankScopeOptions,
): MnemopiBankScope {
	const project = projectBank(configured, cwd, options);
	const globalBank = sharedBank(configured);
	switch (scoping) {
		case "global":
			return {
				baseBank: globalBank,
				bank: globalBank,
				globalBank,
				retainBank: globalBank,
				recallBanks: [globalBank],
			};
		case "per-project":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				recallBanks: [project],
			};
		case "per-project-tagged":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				recallBanks: project === globalBank ? [project] : [project, globalBank],
			};
	}
}

function sharedBank(configured: string | undefined): string {
	return sanitizeBankName(configured) ?? DEFAULT_SHARED_BANK;
}

/** Identity + storage inputs for {@link computeMnemopiBankScope}. */
export interface ProjectBankScopeOptions {
	/** Pre-resolved logical identity; derived from cwd when omitted. */
	identity?: ProjectIdentity;
	/** Mnemopi db path; activates the primary-bank registry under `<dbDir>/project-banks.json`. */
	dbPath?: string;
}

/**
 * Per-project bank id from the canonical logical-project identity (see project-identity.ts):
 * clones sharing a normalized remote and linked worktrees resolve to the same bank.
 *
 * `options.dbPath` activates the deterministic primary-bank registry, which preserves
 * pre-existing banks as the primary write target — no migration, no duplicate silo.
 * The first resolution for an identity registers the existing bank (the legacy
 * cwd-keyed bank for this exact cwd when one exists on disk, otherwise the
 * identity-named bank), and every later clone or worktree of the same logical
 * project resolves to that registered primary. All resolvers compute the same
 * value from stable on-disk state, so concurrent writers store the same mapping.
 */
function projectBank(configured: string | undefined, cwd: string, options?: ProjectBankScopeOptions): string {
	const identity = options?.identity ?? resolveProjectIdentity(cwd);
	const base = sanitizeBankName(configured);
	const segment = projectIdentityBankSegment(identity);
	const identityBank = limitBankName(base ? `${base}-${segment}` : segment);
	if (options?.dbPath === undefined) return identityBank;
	return resolvePrimaryProjectBank(options.dbPath, identity.key, {
		identityBank,
		legacyBank: legacyCwdBank(base, cwd),
	});
}

/** Pre-identity naming: the cwd-hash segment `projectBankSegment(path.resolve(cwd))`. */
function legacyCwdBank(base: string | undefined, cwd: string): string {
	const segment = projectBankSegment(path.resolve(cwd || "."));
	return limitBankName(base ? `${base}-${segment}` : segment);
}

/** Registry cap: entries beyond this are dropped (oldest first) on rewrite. */
const PROJECT_BANK_REGISTRY_LIMIT = 512;

function projectBankRegistryPath(dbPath: string): string {
	return path.join(path.dirname(dbPath), "project-banks.json");
}

interface ProjectBankRegistryEntry {
	bank: string;
	/** Directory whose legacy bank became the primary; the identity bank otherwise. */
	primaryFrom: string;
}

type ProjectBankRegistryFile = Record<string, ProjectBankRegistryEntry>;

/**
 * Deterministic, concurrency-safe primary-bank resolution: identity key → primary bank in
 * `<dbDir>/project-banks.json`. Deterministic order: a registered bank wins; else the legacy
 * cwd-keyed bank when it exists on disk (backward primary-bank preservation — cleaned banks
 * keep receiving writes); else the identity-named bank. Concurrent resolvers compute the
 * same value from stable on-disk state, so last-writer-wins writes store the same mapping
 * and the atomic tmp+rename write never interleaves. Any I/O error falls back to the
 * deterministic identity bank.
 */
function resolvePrimaryProjectBank(
	dbPath: string,
	identityKey: string,
	candidates: { identityBank: string; legacyBank: string },
): string {
	const registryPath = projectBankRegistryPath(dbPath);
	let registry: ProjectBankRegistryFile;
	try {
		registry = readProjectBankRegistry(registryPath);
	} catch {
		return candidates.identityBank;
	}
	const registered = registry[identityKey];
	if (typeof registered?.bank === "string" && registered.bank.length > 0) {
		return limitBankName(registered.bank);
	}
	const preserveLegacy =
		candidates.legacyBank !== candidates.identityBank && bankFileExists(dbPath, candidates.legacyBank);
	const primary = preserveLegacy ? limitBankName(candidates.legacyBank) : candidates.identityBank;
	if (preserveLegacy || bankFileExists(dbPath, candidates.identityBank)) {
		writeProjectBankRegistry(registryPath, {
			...registry,
			[identityKey]: { bank: primary, primaryFrom: bankDbPath(dbPath, primary) },
		});
	}
	return primary;
}

/** A per-project bank lives at `<dbDir>/banks/<bank>/mnemopi.db`; the shared bank is `dbPath` itself. */
function bankDbPath(dbPath: string, bank: string): string {
	return bank === DEFAULT_SHARED_BANK ? dbPath : path.join(path.dirname(dbPath), "banks", bank, "mnemopi.db");
}

function bankFileExists(dbPath: string, bank: string): boolean {
	try {
		return fs.statSync(bankDbPath(dbPath, bank)).isFile();
	} catch {
		return false;
	}
}

function readProjectBankRegistry(registryPath: string): ProjectBankRegistryFile {
	if (!fs.existsSync(registryPath)) return {};
	const parsed: unknown = JSON.parse(fs.readFileSync(registryPath, "utf8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const out: ProjectBankRegistryFile = {};
	for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof entry !== "object" || entry === null) continue;
		const { bank, primaryFrom }: Partial<Record<keyof ProjectBankRegistryEntry, unknown>> = entry;
		if (typeof bank !== "string" || bank.length === 0) continue;
		out[key] = {
			bank,
			primaryFrom: typeof primaryFrom === "string" ? primaryFrom : "",
		};
	}
	return out;
}

function writeProjectBankRegistry(registryPath: string, registry: ProjectBankRegistryFile): void {
	try {
		const entries = Object.entries(registry);
		const bounded =
			entries.length > PROJECT_BANK_REGISTRY_LIMIT
				? Object.fromEntries(entries.slice(entries.length - PROJECT_BANK_REGISTRY_LIMIT))
				: registry;
		const tmp = `${registryPath}.tmp-${process.pid}-${Date.now()}`;
		fs.mkdirSync(path.dirname(registryPath), { recursive: true });
		fs.writeFileSync(tmp, `${JSON.stringify(bounded, null, 2)}\n`);
		fs.renameSync(tmp, registryPath);
	} catch (error) {
		logger.debug("Mnemopi: project-bank registry write failed", { registryPath, error: String(error) });
	}
}

/**
 * Path-keyed segment for the sharpshooter project store: `<sanitized-basename>-<Bun.hash(projectRoot)>`.
 * Mnemopi banks do not use this; they key on the logical identity in project-identity.ts.
 */
export function projectBankSegment(projectRoot: string): string {
	const project = sanitizeBankName(path.basename(projectRoot)) ?? "default";
	return limitBankName(`${project}-${Bun.hash(projectRoot).toString(36)}`);
}

/**
 * Discover sibling banks under `<dbDir>/banks/` whose rows verifiably belong to the active logical
 * project (see {@link bankBelongsToProject}) and add them to the recall set. Banks are matched by row
 * metadata, never by name, so unrelated projects are never combined.
 *
 * Robust by design: a missing banks directory, unreadable bank dir, or corrupt SQLite file is
 * silently skipped. Scanning is capped at {@link LEGACY_BANK_SCAN_LIMIT} to bound startup cost.
 */
export function extendRecallWithLegacyBanks(
	resolved: readonly string[],
	dbPath: string,
	cwd: string,
): readonly string[] {
	return withLoopPhase("mnemopi.open", () => {
		const banksDir = path.join(path.dirname(dbPath), "banks");
		const activeKey = resolveProjectIdentity(cwd).key;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(banksDir, { withFileTypes: true });
		} catch {
			return resolved;
		}
		const keyByCwd = new Map<string, string>();
		const keyOfCwd = (dir: string): string => {
			let key = keyByCwd.get(dir);
			if (key === undefined) {
				key = resolveProjectIdentity(dir).key;
				keyByCwd.set(dir, key);
			}
			return key;
		};
		const have = new Set(resolved);
		const extras: string[] = [];
		let scanned = 0;
		for (const entry of entries) {
			if (!entry.isDirectory() || have.has(entry.name)) continue;
			if (scanned >= LEGACY_BANK_SCAN_LIMIT) break;
			scanned++;
			const candidate = path.join(banksDir, entry.name, "mnemopi.db");
			if (bankBelongsToProject(candidate, activeKey, keyOfCwd)) extras.push(entry.name);
		}
		return extras.length === 0 ? resolved : [...resolved, ...extras];
	});
}

/** Maximum distinct (project_identity, cwd) groups a legacy bank may hold and still be verified. */
const MAX_LEGACY_IDENTITY_GROUPS = 32;

/**
 * A legacy bank belongs to the active project only when every distinct row group verifies for it:
 * rows carrying `project_identity` must equal the active key, and rows without it must have a `cwd`
 * whose identity resolves to the active key. Empty banks and any unverifiable group reject the bank.
 */
function bankBelongsToProject(dbPath: string, activeKey: string, keyOfCwd: (cwd: string) => string): boolean {
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		const rows = db
			.prepare<{ pid: unknown; cwd: unknown }, [string, string, number]>(`
				SELECT DISTINCT json_extract(metadata_json, ?1) AS pid, json_extract(metadata_json, ?2) AS cwd
				FROM working_memory
				LIMIT ?3
			`)
			.all(`$.${PROJECT_IDENTITY_METADATA_KEY}`, "$.cwd", MAX_LEGACY_IDENTITY_GROUPS + 1);
		if (rows.length === 0 || rows.length > MAX_LEGACY_IDENTITY_GROUPS) return false;
		return rows.every(row => {
			if (typeof row.pid === "string") return row.pid === activeKey;
			return typeof row.cwd === "string" && keyOfCwd(row.cwd) === activeKey;
		});
	} catch (error) {
		logger.debug("Mnemopi: legacy bank probe failed", { dbPath, error: String(error) });
		return false;
	} finally {
		try {
			db?.close();
		} catch {
			// nothing to do — read-only handle.
		}
	}
}

export function truncateApproxTokens(text: string, tokenLimit: number): string {
	const maxChars = Math.max(0, tokenLimit * 4);
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
