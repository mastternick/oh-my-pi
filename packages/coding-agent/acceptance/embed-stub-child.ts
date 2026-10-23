/**
 * Child process of startEmbeddingStubProcess: an OpenAI-style embeddings endpoint on a free port.
 * Handshake: prints `URL http://127.0.0.1:<port>/v1` on stdout once bound. On SIGTERM, SIGINT, or
 * exit it writes `POSTS=<n>` to $XM_EMBED_COUNTER so the parent can assert it served requests.
 * Vectors reuse the in-process stub's deterministic ((k + row + 1) % 17) + 1 shape.
 */
import * as fs from "node:fs";
import { embeddingDimFor } from "@oh-my-pi/pi-mnemopi";

const model = process.env.XM_EMBED_MODEL ?? "";
const counterFile = process.env.XM_EMBED_COUNTER ?? "";
const dim = embeddingDimFor(model);
if (model === "" || counterFile === "") {
	console.error("embed-stub-child requires XM_EMBED_MODEL and XM_EMBED_COUNTER");
	process.exit(2);
}

let posts = 0;
let stopping = false;
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/embeddings") {
			return new Response("not found", { status: 404 });
		}
		posts++;
		const body = (await req.json()) as { input: string[] };
		return Response.json({
			data: body.input.map((_text, row) => ({
				embedding: Array.from({ length: dim }, (_, k) => ((k + row + 1) % 17) + 1),
			})),
		});
	},
});

function writeCounter(): void {
	if (stopping) return;
	stopping = true;
	try {
		fs.writeFileSync(counterFile, `POSTS=${posts}\n`);
	} catch {
		// The parent removed the counter file already; the count is only read while the child runs.
	}
}

process.on("SIGTERM", () => {
	writeCounter();
	server.stop(true);
	process.exit(0);
});
process.on("SIGINT", () => {
	writeCounter();
	server.stop(true);
	process.exit(0);
});
process.on("exit", writeCounter);

console.log(`URL http://127.0.0.1:${server.port}/v1`);
