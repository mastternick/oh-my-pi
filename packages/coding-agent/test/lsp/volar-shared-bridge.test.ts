import { afterEach, describe, expect, it, mock } from "bun:test";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { encodeMessageFrame } from "../../src/jsonrpc/message-framing";
import { MUX_CONNECT_METHOD, type MuxConnectParams } from "../../src/lsp/mux/protocol";
import { LspMuxServer } from "../../src/lsp/mux/server";
import type { LspTransport, LspWriteSink } from "../../src/lsp/types";
import { createVueProject, restoreIsolatedPath, type VueProjectOptions } from "../helpers/vue-lsp-project";

/**
 * The bridge must work for broker-shared clients too, where `client.proc` is an
 * IPC link to the project's LSP mux instead of a spawned process. The mux daemon
 * itself is launched through the process broker (not available under `bun test`),
 * so the connector is replaced by one that dials a mux server started here; the
 * link, framing, handshake, and LSP traffic are the production ones.
 */
let muxEndpoint: string | null = null;
const links: IpcConnection[] = [];

function dialSharedLspTransport(params: MuxConnectParams): LspTransport {
	if (!muxEndpoint) throw new Error("no mux endpoint");
	const endpoint = muxEndpoint;
	const exited = Promise.withResolvers<number>();
	exited.promise.catch(() => {});
	let exitCode: number | null = null;
	let needDrain = false;
	let connection: IpcConnection | undefined;
	let flushed = false;
	// The client writes `initialize` as soon as the transport exists, before the
	// async dial completes: hold those bytes and send them after the handshake.
	const unsent: Uint8Array[] = [];
	const stdout = new ReadableStream<Uint8Array>({
		async start(controller) {
			connection = await IpcConnection.connect(endpoint, { framing: "raw" });
			links.push(connection);
			connection.startRaw(
				chunk => controller.enqueue(chunk),
				() => {
					try {
						controller.close();
					} catch {
						// already closed
					}
					exitCode = 0;
					exited.resolve(0);
				},
			);
			if (!flushed) {
				flushed = true;
				connection.send(encodeMessageFrame({ jsonrpc: "2.0", id: "connect", method: MUX_CONNECT_METHOD, params }));
			}
			for (const bytes of unsent.splice(0)) {
				needDrain = !connection.send(bytes);
			}
		},
	});
	const stdin: LspWriteSink = {
		write(data) {
			const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
			if (!connection || !flushed) {
				unsent.push(bytes);
				return bytes.byteLength;
			}
			needDrain = !connection.send(bytes);
			return bytes.byteLength;
		},
		flush() {
			if (!needDrain || !connection || connection.closed) return;
			return connection.drained().then(() => {
				needDrain = false;
			});
		},
	};
	return {
		stdin,
		stdout,
		exited: exited.promise,
		get exitCode() {
			return exitCode;
		},
		sharedMux: true,
		kill() {
			connection?.destroy();
		},
		peekStderr() {
			return "";
		},
	};
}

mock.module(path.join(import.meta.dir, "..", "..", "src", "lsp", "mux", "daemon.ts"), () => ({
	connectSharedLspTransport: async (options: {
		command: string;
		args: string[];
		cwd: string;
		env?: Record<string, string>;
		initializationOptions: unknown;
	}) => {
		if (!muxEndpoint) return null;
		return dialSharedLspTransport({
			command: options.command,
			args: options.args,
			cwd: options.cwd,
			env: options.env,
			initializationOptions: options.initializationOptions,
		});
	},
}));

// Imported dynamically: a static import would load client.ts → mux/daemon.ts before
// `mock.module` above replaces the connector, so the mock would never be applied.
const { ensureFileOpen, getOrCreateClient, holdSharedLsp, sendRequest, shutdownAll } =
	await import("@oh-my-pi/pi-coding-agent/lsp/client");
const { getConfig } = await import("@oh-my-pi/pi-coding-agent/lsp/config");
const { fileToUri } = await import("@oh-my-pi/pi-coding-agent/lsp/utils");

const tempDirs: TempDir[] = [];
let mux: LspMuxServer | undefined;
let sharedHold: { release(): void } | undefined;

function createProject(options: VueProjectOptions = {}) {
	const project = createVueProject(options);
	tempDirs.push(project.tempDir);
	return project;
}

afterEach(async () => {
	sharedHold?.release();
	sharedHold = undefined;
	await shutdownAll();
	muxEndpoint = null;
	for (const link of links.splice(0)) link.destroy();
	await mux?.shutdown();
	mux = undefined;
	for (const tempDir of tempDirs.splice(0)) await tempDir.remove();
	restoreIsolatedPath();
});

describe("Volar bridge over shared language servers", () => {
	it("forwards tsserver requests and mirrors documents through the mux", async () => {
		const tempDir = TempDir.createSync("@omp-volar-mux-");
		tempDirs.push(tempDir);
		mux = new LspMuxServer();
		await mux.listen(ipcEndpoint(tempDir.path(), "lsp-mux"));
		muxEndpoint = ipcEndpoint(tempDir.path(), "lsp-mux");
		sharedHold = holdSharedLsp(true);

		const { dir, appVue } = createProject({ localTypescript: true });
		const config = getConfig(dir);
		const volar = await getOrCreateClient(config.servers["vue-language-server"], dir, 10_000);
		expect(volar.proc.sharedMux).toBe(true);

		// Opening the component is what starts the companion and hands it the document.
		await ensureFileOpen(volar, appVue);
		const result = (await sendRequest(
			volar,
			"textDocument/definition",
			{ textDocument: { uri: fileToUri(appVue) } },
			undefined,
			10_000,
		)) as Array<{ uri: string }>;
		expect(result[0]?.uri).toBe(fileToUri(appVue));

		// The TypeScript companion is broker-shared too, and it saw the .vue document.
		const companion = await getOrCreateClient(config.servers["typescript-language-server"], dir, 10_000);
		expect(companion.proc.sharedMux).toBe(true);
		const state = (await sendRequest(companion, "test/state", {}, undefined, 5_000)) as {
			languageIds: Record<string, string>;
		};
		expect(state.languageIds[fileToUri(appVue)]).toBe("vue");
		expect(mux.serverKeys.length).toBeGreaterThanOrEqual(2);
	}, 20_000);
});
