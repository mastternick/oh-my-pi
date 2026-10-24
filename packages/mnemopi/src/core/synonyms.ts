export const SYNONYM_GROUPS = {
	database: ["db", "datastore", "data_store"],
	password: ["pass", "pwd", "passwd", "credential", "secret", "token"],
	config: ["configuration", "settings", "cfg", "setup"],
	error: ["bug", "issue", "fault", "failure", "crash", "exception", "traceback"],
	fix: ["repair", "resolve", "solve", "patch", "correct", "address"],
	deploy: ["deployment", "release", "ship", "push", "rollout"],
	server: ["host", "machine", "vm", "instance", "node", "vps"],
	api: ["endpoint", "interface", "service"],
	key: ["token", "credential", "secret", "api_key"],
	user: ["account", "profile", "identity", "person"],
	model: ["llm", "ai", "provider", "gpt", "claude", "gemini"],
	speed: ["fast", "quick", "performance", "latency", "throughput"],
	memory: ["recall", "remember", "storage", "retention"],
	search: ["find", "lookup", "query", "retrieve", "locate"],
	file: ["document", "doc", "text", "note"],
	code: ["script", "program", "source", "implementation"],
	test: ["verify", "check", "validate", "probe", "examine"],
	backup: ["snapshot", "copy", "save", "archive"],
	install: ["setup", "configure", "bootstrap", "init"],
	update: ["upgrade", "refresh", "renew", "sync"],
	delete: ["remove", "destroy", "purge", "clean", "wipe", "erase"],
	list: ["show", "display", "enumerate", "catalog"],
	time: ["date", "when", "timestamp", "schedule"],
	url: ["link", "address", "uri", "path"],
	health: ["status", "check", "pulse", "alive", "up"],
	service: ["daemon", "process", "systemd", "worker"],
	port: ["socket", "bind", "listen"],
	network: ["internet", "connection", "connectivity", "dns"],
	ssh: ["terminal", "shell", "remote", "connect"],
	git: ["commit", "push", "pull", "repo", "repository", "branch"],
	log: ["output", "stdout", "stderr", "trace", "debug"],
	cron: ["schedule", "job", "task", "timer", "periodic"],
	email: ["mail", "message", "inbox", "smtp"],
	image: ["picture", "photo", "screenshot", "graphic"],
	browser: ["web", "page", "site", "navigate", "chrome"],
	monitor: ["watch", "observe", "track", "survey"],
	alert: ["notify", "notification", "warning", "ping"],
	migrate: ["transfer", "move", "relocate", "port"],
	compare: ["diff", "versus", "vs", "contrast"],
	save: ["store", "persist", "preserve", "keep"],
} as const;

/**
 * Romanian function words in both diacritic and plain forms. Forms that are common English words or acronyms
 * (`ai`, `al`, `un`, `e`, `ca`, `sa`, `care`, `sub`, `era`, `tie`, ...) are excluded so English recall is unchanged.
 */
export const ROMANIAN_FUNCTION_WORDS: Record<string, true> = {
	// articles and demonstratives
	acel: true,
	acea: true,
	acei: true,
	acele: true,
	acest: true,
	acesta: true,
	aceasta: true,
	aceste: true,
	acestea: true,
	acestui: true,
	acestei: true,
	această: true,
	aceștia: true,
	acestia: true,
	acești: true,
	acesti: true,
	cel: true,
	cea: true,
	cei: true,
	cele: true,
	celor: true,
	// prepositions
	de: true,
	la: true,
	cu: true,
	pe: true,
	din: true,
	dintre: true,
	despre: true,
	pentru: true,
	prin: true,
	printre: true,
	fără: true,
	fara: true,
	după: true,
	dupa: true,
	până: true,
	pana: true,
	între: true,
	intre: true,
	către: true,
	catre: true,
	spre: true,
	peste: true,
	lângă: true,
	langa: true,
	asupra: true,
	împotriva: true,
	impotriva: true,
	// conjunctions
	și: true,
	si: true,
	sau: true,
	dar: true,
	căci: true,
	caci: true,
	deci: true,
	decât: true,
	decat: true,
	dacă: true,
	daca: true,
	când: true,
	cand: true,
	cum: true,
	nici: true,
	cine: true,
	unde: true,
	ce: true,
	// pronouns
	lui: true,
	lor: true,
	îmi: true,
	imi: true,
	îți: true,
	iti: true,
	își: true,
	isi: true,
	te: true,
	se: true,
	le: true,
	noi: true,
	voi: true,
	ele: true,
	tu: true,
	mie: true,
	// verbs
	este: true,
	sunt: true,
	suntem: true,
	sunteți: true,
	sunteti: true,
	ești: true,
	esti: true,
	fi: true,
	fost: true,
	fiind: true,
	avem: true,
	aveți: true,
	aveti: true,
	avea: true,
	aveau: true,
	erau: true,
	// adverbs
	nu: true,
	mai: true,
	doar: true,
	foarte: true,
	chiar: true,
	prea: true,
	poate: true,
	deja: true,
	aici: true,
	acolo: true,
};

export const STOP_WORDS = new Set<string>([
	...Object.keys(ROMANIAN_FUNCTION_WORDS),
	"a",
	"an",
	"the",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"can",
	"shall",
	"must",
	"i",
	"you",
	"he",
	"she",
	"it",
	"we",
	"they",
	"me",
	"him",
	"her",
	"us",
	"them",
	"my",
	"your",
	"his",
	"its",
	"our",
	"their",
	"mine",
	"yours",
	"hers",
	"ours",
	"theirs",
	"what",
	"which",
	"who",
	"whom",
	"where",
	"when",
	"why",
	"how",
	"this",
	"that",
	"these",
	"those",
	"of",
	"in",
	"to",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"under",
	"and",
	"but",
	"or",
	"nor",
	"not",
	"so",
	"than",
	"too",
	"very",
	"just",
	"about",
	"also",
	"really",
	"actually",
	"basically",
	"simply",
	"if",
	"then",
	"else",
	"while",
	"because",
	"though",
	"although",
]);

type Canonical = keyof typeof SYNONYM_GROUPS;

const WORD_TO_CANONICAL = buildReverseMap();

function buildReverseMap(): ReadonlyMap<string, Canonical> {
	const reverse = new Map<string, Canonical>();
	for (const canonical in SYNONYM_GROUPS) {
		const key = canonical as Canonical;
		reverse.set(key, key);
		for (const synonym of SYNONYM_GROUPS[key]) reverse.set(synonym, key);
	}
	return reverse;
}

export function normalizeQuery(query: string): string {
	const canonicalWords = new Set<string>();
	for (const rawWord of query.toLowerCase().split(/\s+/)) {
		if (rawWord.length === 0 || STOP_WORDS.has(rawWord)) continue;
		canonicalWords.add(WORD_TO_CANONICAL.get(rawWord) ?? rawWord);
	}
	return Array.from(canonicalWords).sort().join(" ");
}
export function expandQuery(query: string): string {
	const words = query.toLowerCase().split(/\s+/);
	const expandedParts: string[] = [];
	for (const word of words) {
		if (word.length === 0) continue;
		if (STOP_WORDS.has(word)) {
			expandedParts.push(word);
			continue;
		}
		const canonical = WORD_TO_CANONICAL.get(word);
		if (canonical !== undefined) {
			const group = SYNONYM_GROUPS[canonical];
			let expanded = `(${canonical}`;
			for (const synonym of group) expanded += `|${synonym}`;
			expanded += ")";
			expandedParts.push(expanded);
		} else {
			expandedParts.push(word);
		}
	}
	return expandedParts.join(" ");
}
export function getSynonyms(word: string): string[] {
	const lowered = word.toLowerCase();
	const canonical = WORD_TO_CANONICAL.get(lowered);
	if (canonical === undefined) return [lowered];
	return [canonical, ...SYNONYM_GROUPS[canonical]];
}
