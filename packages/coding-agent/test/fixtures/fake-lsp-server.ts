import { MessageFramer } from "../../src/jsonrpc/message-framing";

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

interface OpenDocumentParams {
	textDocument: { uri: string; version: number; text: string; languageId?: string };
}

interface ChangeDocumentParams {
	textDocument: { uri: string; version: number };
}

interface CloseDocumentParams {
	textDocument: { uri: string };
}

/** Server role under test: plain fixture, Volar client, or its TypeScript companion. */
const mode = Bun.argv[2] ?? "default";
const TSSERVER_REQUEST_COMMAND = "typescript.tsserverRequest";
/** Delays `initialize` so tests can observe a request arriving mid-cold-start. */
const INIT_DELAY_MS = mode === "slow-typescript" ? 400 : 0;

function isVolarMode(): boolean {
	return mode === "volar" || mode === "volar-malformed" || mode === "volar-mixed";
}

function isTypeScriptMode(): boolean {
	return mode === "typescript" || mode === "slow-typescript";
}

let initializeCount = 0;
let processId: number | null = null;
let initializationOptions: unknown = null;
const didOpen: Record<string, number> = {};
const didChange: Record<string, number[]> = {};
const didClose: string[] = [];
const languageIds: Record<string, string> = {};
const notifications: string[] = [];
const requests: string[] = [];
const documents = new Map<string, { version: number; text: string }>();
const workspaceFolders = new Set<string>();
const watchedFileChanges: unknown[] = [];
/** `tsserver/response` payloads a Volar role received, in arrival order. */
const tsserverResponses: unknown[] = [];
let nextServerRequestId = 1;
/** Volar's own `tsserver/request` ids, mapped to the LSP request awaiting them. */
const pendingVolarRequests = new Map<number, { rpcId: string | number; action: string }>();
let nextVolarRequestId = 1;
const pendingServerRequests = new Map<
	string | number,
	{ resolve: (response: { result: unknown; error: unknown }) => void }
>();

function send(message: JsonRpcMessage): void {
	const json = JSON.stringify(message);
	const bytes = Buffer.byteLength(json);
	process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
}

function respond(id: string | number, result: unknown, error?: unknown): void {
	if (error === undefined) send({ jsonrpc: "2.0", id, result });
	else send({ jsonrpc: "2.0", id, error });
}

function publishDiagnostics(uri: string, version: number): void {
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: {
			uri,
			version,
			diagnostics: [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					message: "fake",
					severity: 2,
				},
			],
		},
	});
}

async function requestClient(method: string, params: unknown): Promise<{ result: unknown; error: unknown }> {
	const id = `fake-${nextServerRequestId++}`;
	const { promise, resolve } = Promise.withResolvers<{ result: unknown; error: unknown }>();
	pendingServerRequests.set(id, { resolve });
	send({ jsonrpc: "2.0", id, method, params });
	return promise;
}

/** Capabilities the role advertises: Volar's, the TypeScript wrapper's, or none. */
function capabilitiesForMode(): Record<string, unknown> {
	if (isVolarMode()) {
		return {
			documentSymbolProvider: true,
			definitionProvider: true,
			referencesProvider: true,
			hoverProvider: true,
		};
	}
	if (isTypeScriptMode()) {
		return {
			executeCommandProvider: { commands: [TSSERVER_REQUEST_COMMAND] },
			workspaceSymbolProvider: true,
		};
	}
	if (mode === "broken-symbol" || mode === "symbol-error") return { workspaceSymbolProvider: true };
	// `dynamic-symbol` registers `workspace/symbol` after initialize instead of
	// advertising it in the static handshake.
	return {};
}

/** Ask the client to run a tsserver command on Volar's behalf. */
function requestTsserver(rpcId: string | number, action: string, payload: Record<string, unknown>): void {
	const tsRequestId = nextVolarRequestId++;
	pendingVolarRequests.set(tsRequestId, { rpcId, action });
	send({
		jsonrpc: "2.0",
		method: "tsserver/request",
		params: [[tsRequestId, `_vue:${action}`, payload]],
	});
}

/**
 * Turn the tsserver body the client forwarded into the LSP answer Volar would
 * produce, so tests can tell "bridged" from "answered null".
 */
function volarResult(action: string, body: unknown): unknown {
	const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
	if (typeof body !== "object" || body === null) {
		return action === "documentSymbol" || action === "references" ? [] : null;
	}
	const file = "file" in body && typeof body.file === "string" ? body.file : "";
	switch (action) {
		case "documentSymbol":
			return [{ name: `volar:${file.split("/").pop()}`, kind: 12, range, selectionRange: range }];
		case "definition":
			return [{ uri: file, range }];
		case "references":
			return [
				{ uri: file, range },
				{ uri: file, range },
			];
		case "hover":
			return { contents: { kind: "plaintext", value: `via volar for ${file}` } };
		default:
			return null;
	}
}

async function handleRequest(message: JsonRpcMessage): Promise<void> {
	const id = message.id;
	if (id === undefined || message.method === undefined) return;
	requests.push(message.method);

	switch (message.method) {
		case "initialize": {
			initializeCount++;
			const params = message.params as { processId?: number | null; initializationOptions?: unknown } | undefined;
			processId = params?.processId ?? null;
			initializationOptions = params?.initializationOptions ?? null;
			if (INIT_DELAY_MS > 0) await Bun.sleep(INIT_DELAY_MS);
			if (mode !== "default") {
				// Project-aware actions wait for a load; a begin/end pair says "loaded".
				send({ jsonrpc: "2.0", method: "$/progress", params: { token: "fake-load", value: { kind: "begin" } } });
				send({ jsonrpc: "2.0", method: "$/progress", params: { token: "fake-load", value: { kind: "end" } } });
			}
			respond(id, {
				capabilities: capabilitiesForMode(),
				serverInfo: { name: mode === "default" ? "fake-lsp" : `fake-lsp-${mode}`, version: String(process.pid) },
			});
			break;
		}
		case "textDocument/documentSymbol":
		case "textDocument/definition":
		case "textDocument/references":
		case "textDocument/hover": {
			const action = message.method.slice("textDocument/".length);
			const params = message.params as { textDocument?: { uri?: string } } | undefined;
			const uri = params?.textDocument?.uri ?? "";
			if (isVolarMode()) {
				// Volar answers by asking the client to run a tsserver command.
				if (mode === "volar-malformed") {
					// Missing payload: not Volar's wire contract, so the bridge must
					// answer the id in place instead of forwarding to TypeScript.
					send({ jsonrpc: "2.0", method: "tsserver/request", params: [[nextVolarRequestId++, `_vue:${action}`]] });
				} else if (mode === "volar-mixed") {
					// One batch mixing unusable entries with the request Volar awaits:
					// two carry a usable id but no command, one has no usable id at all.
					const tsRequestId = nextVolarRequestId++;
					pendingVolarRequests.set(tsRequestId, { rpcId: id, action });
					send({
						jsonrpc: "2.0",
						method: "tsserver/request",
						params: [
							[nextVolarRequestId++],
							[nextVolarRequestId++, { not: "a command" }, { file: uri }],
							[{}, `_vue:${action}`, { file: uri }],
							[tsRequestId, `_vue:${action}`, { file: uri }],
						],
					});
					break;
				}
				requestTsserver(id, action, { file: uri });
				break;
			}
			if (!isTypeScriptMode()) {
				respond(id, undefined, { code: -32601, message: `Method not found: ${message.method}` });
				break;
			}
			// The TypeScript role is the plugin host Volar delegates these to, mapping
			// template positions back into the .vue file.
			const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
			if (message.method === "textDocument/hover") {
				respond(id, { contents: { kind: "plaintext", value: `via tsserver for ${uri}` }, range });
			} else if (message.method === "textDocument/references") {
				respond(id, [
					{ uri, range },
					{ uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
				]);
			} else {
				respond(id, [{ uri, range }]);
			}
			break;
		}
		case "workspace/executeCommand": {
			const params = message.params as { command?: string; arguments?: unknown[] } | undefined;
			if (!isTypeScriptMode() || params?.command !== TSSERVER_REQUEST_COMMAND) {
				respond(id, undefined, { code: -32601, message: `Method not found: ${message.method}` });
				break;
			}
			const [tsCommand, payload] = params.arguments ?? [];
			const echoed: Record<string, unknown> = { tsCommand, source: "tsserver" };
			if (typeof payload === "object" && payload !== null) {
				if ("file" in payload && typeof payload.file === "string") echoed.file = payload.file;
			}
			respond(id, { success: true, body: echoed });
			break;
		}
		case "workspace/symbol": {
			if (mode === "symbol-error") {
				// A genuine failure (not method-not-found) reporting a stack trace: only
				// its first line belongs in an aggregated answer.
				respond(id, undefined, {
					code: -32603,
					message: "Internal error: symbol index rebuild failed\n    at Index.query (/opt/ls/index.js:12:9)",
				});
				break;
			}
			if (mode === "broken-symbol") {
				// Advertises the capability but answers method-not-found with a stack trace,
				// the shape Volar returns for requests it does not implement.
				respond(id, undefined, {
					code: -32601,
					message:
						"Method not found: workspace/symbol\n    at Volar.symbols (/opt/volar/index.js:42:7)\n    at async handle (/opt/volar/main.js:9:3)",
				});
				break;
			}
			if (!isTypeScriptMode() && mode !== "dynamic-symbol") {
				respond(id, undefined, { code: -32601, message: `Method not found: ${message.method}` });
				break;
			}
			const query = (message.params as { query?: string } | undefined)?.query ?? "";
			respond(id, [
				{
					name: `Symbol_${query}`,
					kind: 12,
					location: {
						uri: `file:///workspace/${encodeURIComponent(query)}.ts`,
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
					},
				},
			]);
			break;
		}
		case "test/state": {
			const didChangeSnapshot: Record<string, number[]> = {};
			for (const uri in didChange) didChangeSnapshot[uri] = [...didChange[uri]];
			respond(id, {
				initializeCount,
				processId,
				initializationOptions,
				didOpen: { ...didOpen },
				didChange: didChangeSnapshot,
				didClose: [...didClose],
				languageIds: { ...languageIds },
				documents: Object.fromEntries(documents),
				notifications: [...notifications],
				requests: [...requests],
				tsserverResponses: [...tsserverResponses],
				workspaceFolders: [...workspaceFolders],
				watchedFileChanges: [...watchedFileChanges],
			});
			break;
		}
		case "test/documentText": {
			const params = message.params as { uri: string };
			respond(id, documents.get(params.uri)?.text ?? null);
			break;
		}
		case "test/echo":
			respond(id, message.params);
			break;
		case "test/registerSymbols": {
			// Register `workspace/symbol` at runtime and answer only once the client
			// confirmed it, so the caller can rely on the registration being applied.
			const response = await requestClient("client/registerCapability", {
				registrations: [{ id: "fake-workspace-symbol", method: "workspace/symbol" }],
			});
			respond(id, response);
			break;
		}
		case "test/junkHeader":
			// A header block without Content-Length makes the client resync and warn.
			process.stdout.write("Junk: header\r\n\r\n");
			respond(id, null);
			break;
		case "test/serverRequest": {
			const params = message.params as { method: string; params: unknown };
			const response = await requestClient(params.method, params.params);
			respond(id, response);
			break;
		}
		case "shutdown":
			respond(id, null);
			break;
		default:
			respond(id, undefined, { code: -32601, message: `Method not found: ${message.method}` });
	}
}

function handleNotification(message: JsonRpcMessage): void {
	if (message.method === undefined) return;
	notifications.push(message.method);

	switch (message.method) {
		case "textDocument/didOpen": {
			const params = message.params as OpenDocumentParams;
			const { uri, version, text } = params.textDocument;
			didOpen[uri] = (didOpen[uri] ?? 0) + 1;
			const languageId = params.textDocument.languageId;
			if (typeof languageId === "string") languageIds[uri] = languageId;
			documents.set(uri, { version, text });
			publishDiagnostics(uri, version);
			break;
		}
		case "textDocument/didChange": {
			const params = message.params as ChangeDocumentParams;
			const { uri, version } = params.textDocument;
			didChange[uri] ??= [];
			didChange[uri].push(version);
			const previous = documents.get(uri);
			documents.set(uri, { version, text: previous?.text ?? "" });
			publishDiagnostics(uri, version);
			break;
		}
		case "textDocument/didClose": {
			const params = message.params as CloseDocumentParams;
			const { uri } = params.textDocument;
			didClose.push(uri);
			documents.delete(uri);
			break;
		}
		case "workspace/didChangeWorkspaceFolders": {
			const { event } = message.params as { event: { added: { uri: string }[]; removed: { uri: string }[] } };
			for (const folder of event.removed) workspaceFolders.delete(folder.uri);
			for (const folder of event.added) workspaceFolders.add(folder.uri);
			break;
		}
		case "workspace/didChangeWatchedFiles": {
			const { changes } = message.params as { changes: unknown[] };
			watchedFileChanges.push(...changes);
			break;
		}
		case "tsserver/response": {
			// Volar's answers to its own `tsserver/request`s: `[[id, body]]`.
			tsserverResponses.push(message.params);
			if (!isVolarMode() || !Array.isArray(message.params)) break;
			for (const entry of message.params) {
				if (!Array.isArray(entry)) continue;
				const [tsRequestId, body] = entry;
				const pending = typeof tsRequestId === "number" ? pendingVolarRequests.get(tsRequestId) : undefined;
				if (!pending) continue;
				pendingVolarRequests.delete(tsRequestId);
				respond(pending.rpcId, volarResult(pending.action, body));
			}
			break;
		}
		case "exit":
			process.exit(0);
	}
}

function handleMessage(message: JsonRpcMessage): void {
	if (message.method !== undefined) {
		if (message.id !== undefined) void handleRequest(message);
		else handleNotification(message);
		return;
	}
	if (message.id === undefined) return;
	const pending = pendingServerRequests.get(message.id);
	if (!pending) return;
	pendingServerRequests.delete(message.id);
	pending.resolve({ result: message.result ?? null, error: message.error ?? null });
}

const framer = new MessageFramer(Buffer.alloc(0));
for await (const chunk of Bun.stdin.stream()) {
	framer.push(Buffer.from(chunk));
	for (const text of framer.drain(() => {})) {
		handleMessage(JSON.parse(text) as JsonRpcMessage);
	}
}
