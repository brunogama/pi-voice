import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExecResult,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	type AutocompleteItem,
	type EditorComponent,
	type EditorTheme,
	type KeyId,
	type TUI,
} from "@earendil-works/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const EXTENSION_ID = "voice";
const DEFAULT_OPENAI_ENDPOINT =
	"https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_WHISPER_MODEL = "~/.pi/models/ggml-base.en.bin";
const STDERR_LIMIT = 12_000;
const STOP_GRACE_MS = 3_000;
const COMMANDS = [
	"toggle",
	"mode",
	"start",
	"stop",
	"off",
	"cancel",
	"status",
	"doctor",
	"devices",
	"help",
];

type Backend = "whisper-cli" | "openai-compatible";
type InsertMode = "paste" | "append";

type VoiceConfig = {
	backend: Backend;
	backendExplicit: boolean;
	ffmpegPath: string;
	ffmpegFormat: string;
	ffmpegInput: string;
	sampleRate: number;
	channels: number;
	minBytes: number;
	maxSeconds: number;
	endpoint: string;
	model: string;
	apiKey: string | undefined;
	language: string | undefined;
	responseFormat: string;
	timeoutMs: number;
	whisperBin: string;
	whisperModel: string;
	insertMode: InsertMode;
	trailingSpace: boolean;
};

type WhisperCliProfile = {
	textOutputFlag: "--output-txt" | "-otxt";
	outputFileFlag: "--output-file" | "-of";
	noTimestampsFlag?: "--no-timestamps" | "-nt";
	warnings: string[];
};

type FfmpegRecorder = {
	audioPath: string;
	tempDir: string;
	stop: (cfg: VoiceConfig) => Promise<string>;
	dispose: () => Promise<void>;
	stderr: () => string;
};

type RecordingState = {
	kind: "recording";
	recorder: FfmpegRecorder;
	startedAt: number;
	deadlineAt: number;
	timeout: ReturnType<typeof setTimeout>;
	backend: Backend;
	privacyLabel: string;
	cfg: VoiceConfig;
	stopping?: boolean;
};

type TranscribingState = {
	kind: "transcribing";
	token: symbol;
	abort: AbortController;
	backend: Backend;
	audioPath: string;
	cleanup: () => Promise<void>;
};

type VoiceState = RecordingState | TranscribingState;

type PushToTalkState = {
	active: boolean;
	starting?: boolean;
	releaseTimer?: ReturnType<typeof setTimeout>;
	releaseMs: number;
};

type DoctorLine = {
	ok: boolean | "warn";
	text: string;
};

let state: VoiceState | undefined;
let idleNotice: string | undefined;
let audioLevel = 0;
const pushToTalk: PushToTalkState = { active: false, releaseMs: 850 };
const visualizer = {
	levels: Array.from({ length: 64 }, () => 0),
	tick: 0,
	timer: undefined as ReturnType<typeof setInterval> | undefined,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const truncate = (text: string, max = 1200): string => {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
};

const truncateMiddle = (text: string, max = STDERR_LIMIT): string => {
	if (text.length <= max) return text;
	const keep = Math.floor((max - 20) / 2);
	return `${text.slice(0, keep)}\n…[truncated]…\n${text.slice(-keep)}`;
};

const formatError = (error: unknown): string => {
	const raw =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: JSON.stringify(error);
	return (raw || "Unknown error")
		.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
		.replace(/(Authorization\s*:\s*)[^\n\r]+/gi, "$1[redacted]")
		.replace(/((?:api[_-]?key|access[_-]?token)=)[^&\s]+/gi, "$1[redacted]")
		.replace(
			/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi,
			"$1[redacted]@",
		)
		.trim();
};

const expandHome = (value: string): string => {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
};

const parsePositiveInteger = (
	name: string,
	fallback: number,
	min = 1,
): number => {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	if (!/^\d+$/.test(raw.trim())) {
		throw new Error(
			`${name} must be an integer >= ${min}; got ${JSON.stringify(raw)}`,
		);
	}
	const value = Number(raw.trim());
	if (!Number.isSafeInteger(value) || value < min) {
		throw new Error(
			`${name} must be an integer >= ${min}; got ${JSON.stringify(raw)}`,
		);
	}
	return value;
};

const parseBoolean = (name: string, fallback: boolean): boolean => {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new Error(
		`${name} must be 1/0, true/false, yes/no, or on/off; got ${JSON.stringify(raw)}`,
	);
};

const normalizeBackend = (
	rawBackend: string | undefined,
): { backend: Backend; explicit: boolean } => {
	const explicit = rawBackend !== undefined && rawBackend.trim() !== "";
	const raw = (
		rawBackend && rawBackend.trim() !== "" ? rawBackend : "whisper-cli"
	)
		.trim()
		.toLowerCase();
	if (raw === "auto") {
		throw new Error(
			"PI_VOICE_BACKEND=auto is disabled for privacy; choose whisper-cli or openai-compatible",
		);
	}
	if (raw === "whisper-cli" || raw === "local" || raw === "whisper") {
		return { backend: "whisper-cli", explicit };
	}
	if (raw === "openai-compatible" || raw === "openai" || raw === "cloud") {
		return { backend: "openai-compatible", explicit };
	}
	throw new Error(
		`PI_VOICE_BACKEND must be whisper-cli or openai-compatible; got ${JSON.stringify(rawBackend)}`,
	);
};

const defaultCaptureFormat = (): string => {
	if (platform() === "darwin") return "avfoundation";
	if (platform() === "linux") return "pulse";
	return "dshow";
};

const defaultCaptureInput = (): string => {
	if (platform() === "darwin") return ":0";
	if (platform() === "linux") return "default";
	return "audio=Microphone";
};

const loadConfig = (): VoiceConfig => {
	const backend = normalizeBackend(process.env.PI_VOICE_BACKEND);
	const insertMode = (process.env.PI_VOICE_INSERT_MODE ?? "paste")
		.trim()
		.toLowerCase();
	if (insertMode !== "paste" && insertMode !== "append") {
		throw new Error('PI_VOICE_INSERT_MODE must be "paste" or "append"');
	}

	const responseFormat =
		(process.env.PI_VOICE_RESPONSE_FORMAT ?? "json").trim() || "json";
	if (responseFormat !== "json") {
		throw new Error('PI_VOICE_RESPONSE_FORMAT must be "json"');
	}

	return {
		backend: backend.backend,
		backendExplicit: backend.explicit,
		ffmpegPath: expandHome(process.env.PI_VOICE_FFMPEG ?? "ffmpeg"),
		ffmpegFormat: process.env.PI_VOICE_FFMPEG_FORMAT ?? defaultCaptureFormat(),
		ffmpegInput: process.env.PI_VOICE_FFMPEG_INPUT ?? defaultCaptureInput(),
		sampleRate: parsePositiveInteger("PI_VOICE_SAMPLE_RATE", 16_000),
		channels: parsePositiveInteger("PI_VOICE_CHANNELS", 1),
		minBytes: parsePositiveInteger("PI_VOICE_MIN_BYTES", 4096),
		maxSeconds: parsePositiveInteger("PI_VOICE_MAX_SECONDS", 120),
		endpoint: process.env.PI_VOICE_ENDPOINT ?? DEFAULT_OPENAI_ENDPOINT,
		model: process.env.PI_VOICE_MODEL ?? "whisper-1",
		apiKey:
			process.env.PI_VOICE_API_KEY || process.env.OPENAI_API_KEY || undefined,
		language: process.env.PI_VOICE_LANGUAGE?.trim() || undefined,
		responseFormat,
		timeoutMs: parsePositiveInteger("PI_VOICE_TIMEOUT_MS", 120_000),
		whisperBin: expandHome(process.env.PI_VOICE_WHISPER_BIN ?? "whisper-cli"),
		whisperModel: expandHome(
			process.env.PI_VOICE_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL,
		),
		insertMode,
		trailingSpace: parseBoolean("PI_VOICE_TRAILING_SPACE", true),
	};
};

const isLoopbackHostname = (hostname: string): boolean => {
	const normalized = hostname
		.trim()
		.toLowerCase()
		.replace(/^\[/, "")
		.replace(/\]$/, "");
	return (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1"
	);
};

const assertSafeEndpoint = (endpoint: string): URL => {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error("PI_VOICE_ENDPOINT is not a valid URL");
	}
	if (url.username || url.password) {
		throw new Error(
			"PI_VOICE_ENDPOINT must not include username or password credentials",
		);
	}
	if (url.protocol === "https:") return url;
	if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url;
	throw new Error(
		"PI_VOICE_ENDPOINT must use https, except http is allowed only for localhost, 127.0.0.1, or ::1",
	);
};

const endpointHostForUi = (endpoint: string): string => {
	try {
		return new URL(endpoint).host;
	} catch {
		return "invalid endpoint";
	}
};

const requiresAuthForEndpoint = (endpoint: URL | string): boolean => {
	const url =
		typeof endpoint === "string" ? assertSafeEndpoint(endpoint) : endpoint;
	return !isLoopbackHostname(url.hostname);
};

const privacyLabelForConfig = (cfg: VoiceConfig): string => {
	if (cfg.backend === "whisper-cli") return "local whisper-cli (no upload)";
	return `openai-compatible upload to ${endpointHostForUi(cfg.endpoint)}`;
};

const notify = (
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
) => {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	} else {
		const prefix =
			type === "error" ? "ERROR" : type === "warning" ? "WARN" : "INFO";
		console.log(`[voice:${prefix}] ${message}`);
	}
};

const rmsDbToLevel = (raw: string): number => {
	const value = Number(raw);
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, (value + 60) / 60));
};

const observeAudioLevel = (chunk: Buffer | string): void => {
	const text = chunk.toString();
	for (const match of text.matchAll(
		/lavfi\.astats\.Overall\.RMS_level=([-+0-9.]+|-inf)/g,
	)) {
		audioLevel = rmsDbToLevel(match[1] ?? "-inf");
	}
};

const stopVoiceVisualizer = (ctx?: ExtensionContext) => {
	if (visualizer.timer) {
		clearInterval(visualizer.timer);
		visualizer.timer = undefined;
	}
	if (ctx?.hasUI) ctx.ui.setWidget(`${EXTENSION_ID}-spectrum`, undefined);
};

const renderSpectrum = (ctx: ExtensionContext, label: string): string[] => {
	const bars = "▁▂▃▄▅▆▇█";
	const recording = state?.kind === "recording";
	const processing = state?.kind === "transcribing";
	const sourceLevel = recording
		? audioLevel
		: processing
			? 0.25 + 0.2 * Math.sin(visualizer.tick / 2)
			: 0.06 + 0.05 * Math.sin(visualizer.tick / 3);
	const shimmer = 0.08 * (0.5 + 0.5 * Math.sin(visualizer.tick / 4));
	const next = Math.max(0, Math.min(1, sourceLevel + shimmer * Math.random()));
	visualizer.levels.push(next);
	visualizer.levels = visualizer.levels.slice(-64);
	visualizer.tick += 1;

	const graph = visualizer.levels
		.map((level, index) => {
			const ripple = 0.12 * Math.sin(index / 3 + visualizer.tick / 4);
			const value = Math.max(0, Math.min(1, level + ripple));
			const bar = bars[Math.round(value * (bars.length - 1))] ?? "▁";
			if (value > 0.68) return ctx.ui.theme.fg("accent", bar);
			if (value > 0.32) return ctx.ui.theme.fg("muted", bar);
			return ctx.ui.theme.fg("dim", bar);
		})
		.join("");
	return [
		`${ctx.ui.theme.fg("accent", "╭─ voice spectrum")} ${ctx.ui.theme.fg("muted", label)}`,
		`${ctx.ui.theme.fg("dim", "│")} ${graph}`,
		ctx.ui.theme.fg("dim", "╰─ hold Space to speak · release to transcribe"),
	];
};

const startVoiceVisualizer = (ctx: ExtensionContext, label: string) => {
	if (!ctx.hasUI) return;
	stopVoiceVisualizer(ctx);
	ctx.ui.setWidget(`${EXTENSION_ID}-spectrum`, renderSpectrum(ctx, label), {
		placement: "belowEditor",
	});
	visualizer.timer = setInterval(() => {
		if (!pushToTalk.active && !state) {
			stopVoiceVisualizer(ctx);
			return;
		}
		ctx.ui.setWidget(`${EXTENSION_ID}-spectrum`, renderSpectrum(ctx, label), {
			placement: "belowEditor",
		});
	}, 90);
	if (typeof (visualizer.timer as any).unref === "function")
		(visualizer.timer as any).unref();
};

const clearVoiceUi = (ctx?: ExtensionContext) => {
	stopVoiceVisualizer(ctx);
	if (!ctx?.hasUI) return;
	ctx.ui.setStatus(EXTENSION_ID, undefined);
	ctx.ui.setWidget(EXTENSION_ID, undefined);
};

type PushToTalkEditorOptions = {
	ctx: ExtensionContext;
	isActive(): boolean;
	onSpace(ctx: ExtensionContext): void;
	onEscape(ctx: ExtensionContext): void;
};

const isSpaceInput = (data: string): boolean =>
	data === " " || matchesKey(data, "space" as KeyId);

class PushToTalkEditorWrapper implements EditorComponent {
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	borderColor?: (str: string) => string;

	constructor(
		private readonly base: EditorComponent,
		private readonly options: PushToTalkEditorOptions,
	) {}

	private get baseRecord(): Record<string, unknown> {
		return this.base as unknown as Record<string, unknown>;
	}

	get actionHandlers(): Map<string, () => void> | undefined {
		return this.baseRecord.actionHandlers as
			| Map<string, () => void>
			| undefined;
	}

	get onCtrlD(): (() => void) | undefined {
		return this.baseRecord.onCtrlD as (() => void) | undefined;
	}
	set onCtrlD(handler: (() => void) | undefined) {
		this.baseRecord.onCtrlD = handler;
	}

	get onEscape(): (() => void) | undefined {
		return this.baseRecord.onEscape as (() => void) | undefined;
	}
	set onEscape(handler: (() => void) | undefined) {
		this.baseRecord.onEscape = handler;
	}

	get onPasteImage(): (() => void) | undefined {
		return this.baseRecord.onPasteImage as (() => void) | undefined;
	}
	set onPasteImage(handler: (() => void) | undefined) {
		this.baseRecord.onPasteImage = handler;
	}

	get onExtensionShortcut(): ((data: string) => void) | undefined {
		return this.baseRecord.onExtensionShortcut as
			| ((data: string) => void)
			| undefined;
	}
	set onExtensionShortcut(handler: ((data: string) => void) | undefined) {
		this.baseRecord.onExtensionShortcut = handler;
	}

	private syncBase(): void {
		if (this.onSubmit) this.base.onSubmit = this.onSubmit;
		else delete this.base.onSubmit;
		if (this.onChange) this.base.onChange = this.onChange;
		else delete this.base.onChange;
		// Do not delete the wrapped editor's borderColor. CustomEditor and
		// wrappers such as paste-attachments keep a default borderColor function;
		// deleting it makes their render() crash with "borderColor is not a function".
		if (typeof this.borderColor === "function") {
			this.base.borderColor = this.borderColor;
		}
	}

	get focused(): boolean {
		return Boolean(
			(this.base as EditorComponent & { focused?: boolean }).focused,
		);
	}
	set focused(value: boolean) {
		(this.base as EditorComponent & { focused?: boolean }).focused = value;
	}

	render(width: number): string[] {
		this.syncBase();
		return this.base.render(width);
	}

	handleInput(data: string): void {
		this.syncBase();
		if (this.options.isActive()) {
			if (isSpaceInput(data)) {
				this.options.onSpace(this.options.ctx);
				return;
			}
			if (matchesKey(data, "escape" as KeyId)) {
				this.options.onEscape(this.options.ctx);
				return;
			}
		}
		this.base.handleInput(data);
	}

	invalidate(): void {
		this.base.invalidate();
	}

	getText(): string {
		return this.base.getText();
	}

	setText(text: string): void {
		this.syncBase();
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	setAutocompleteProvider(
		provider: Parameters<
			NonNullable<EditorComponent["setAutocompleteProvider"]>
		>[0],
	): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}

	dispose(): void {
		(this.base as EditorComponent & { dispose?: () => void }).dispose?.();
	}
}

const createPushToTalkEditorFactory = (
	previousFactory:
		| ((
				tui: TUI,
				theme: EditorTheme,
				keybindings: KeybindingsManager,
		  ) => EditorComponent)
		| undefined,
	options: PushToTalkEditorOptions,
) => {
	return (
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
	): EditorComponent => {
		const base =
			previousFactory?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings);
		return new PushToTalkEditorWrapper(base, options);
	};
};

const setRecordingUi = (
	ctx: ExtensionContext,
	cfg: VoiceConfig,
	privacyLabel: string,
) => {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(EXTENSION_ID, "Recording… release Space to transcribe");
	ctx.ui.setWidget(EXTENSION_ID, [
		"🎙️ Voice recording",
		"Release Space to transcribe; /voice cancel discards.",
		`Max ${cfg.maxSeconds}s · ${privacyLabel}`,
	]);
	startVoiceVisualizer(ctx, "recording live microphone audio");
};

const setTranscribingUi = (ctx: ExtensionContext, privacyLabel: string) => {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(EXTENSION_ID, "Transcribing… /voice cancel to abort");
	ctx.ui.setWidget(EXTENSION_ID, [
		"📝 Voice transcribing",
		"Esc/Ctrl+C in the loader or /voice cancel aborts.",
		privacyLabel,
	]);
	startVoiceVisualizer(ctx, "transcribing captured audio");
};

const flushIdleNotice = (ctx: ExtensionContext) => {
	if (!idleNotice) return;
	notify(ctx, idleNotice, "warning");
	idleNotice = undefined;
	clearVoiceUi(ctx);
};

const appendStderr = (current: string, chunk: Buffer | string): string =>
	truncateMiddle(current + chunk.toString(), STDERR_LIMIT);

const createSpawnExitTracker = (child: ChildProcessWithoutNullStreams) => {
	let exited = false;
	let spawnError: Error | undefined;
	let code: number | null = null;
	let signal: NodeJS.Signals | null = null;
	let resolveExit: (() => void) | undefined;
	const exitPromise = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});
	const finish = () => {
		exited = true;
		resolveExit?.();
	};
	child.once("error", (error) => {
		spawnError = error;
		finish();
	});
	child.once("close", (exitCode, exitSignal) => {
		code = exitCode;
		signal = exitSignal;
		finish();
	});
	return {
		get exited() {
			return exited;
		},
		get spawnError() {
			return spawnError;
		},
		get code() {
			return code;
		},
		get signal() {
			return signal;
		},
		exitPromise,
	};
};

const startFfmpegCapture = async (
	cfg: VoiceConfig,
): Promise<FfmpegRecorder> => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-voice-"));
	const audioPath = join(tempDir, "recording.wav");
	const args = [
		"-hide_banner",
		"-nostdin",
		"-loglevel",
		"warning",
		"-f",
		cfg.ffmpegFormat,
		"-i",
		cfg.ffmpegInput,
		"-vn",
		"-af",
		"astats=metadata=1:reset=0.2,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=/dev/stderr",
		"-acodec",
		"pcm_s16le",
		"-ar",
		String(cfg.sampleRate),
		"-ac",
		String(cfg.channels),
		"-y",
		audioPath,
	];

	let stderr = "";
	let disposed = false;
	const child = spawn(cfg.ffmpegPath, args, {
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", (chunk) => {
		observeAudioLevel(chunk);
		stderr = appendStderr(stderr, chunk);
	});
	const tracker = createSpawnExitTracker(child);

	const waitForExit = async (timeoutMs: number): Promise<boolean> => {
		if (tracker.exited) return true;
		await Promise.race([tracker.exitPromise, sleep(timeoutMs)]);
		return tracker.exited;
	};

	const stopChild = async () => {
		if (!tracker.exited) {
			child.kill("SIGINT");
			const stopped = await waitForExit(STOP_GRACE_MS);
			if (!stopped && !tracker.exited) {
				child.kill("SIGKILL");
				await waitForExit(1000);
			}
		}
	};

	const dispose = async () => {
		if (disposed) return;
		disposed = true;
		try {
			if (!tracker.exited) {
				child.kill("SIGINT");
				const stopped = await waitForExit(750);
				if (!stopped && !tracker.exited) child.kill("SIGKILL");
			}
		} catch {
			// Best-effort process cleanup.
		}
		await rm(tempDir, { recursive: true, force: true });
	};

	return {
		audioPath,
		tempDir,
		stderr: () => stderr,
		stop: async (stopCfg: VoiceConfig) => {
			await stopChild();
			if (tracker.spawnError) {
				throw new Error(
					`ffmpeg failed to start: ${formatError(tracker.spawnError)}`,
				);
			}
			let audioStat;
			try {
				audioStat = await stat(audioPath);
			} catch {
				throw new Error(
					[
						"No recording file was created by ffmpeg.",
						"Check microphone permission, PI_VOICE_FFMPEG_INPUT, and /voice devices.",
						stderr ? `ffmpeg stderr: ${truncate(stderr, 900)}` : undefined,
					]
						.filter(Boolean)
						.join(" "),
				);
			}
			if (audioStat.size < stopCfg.minBytes) {
				throw new Error(
					[
						`Recording was too small (${audioStat.size} bytes; need at least ${stopCfg.minBytes}).`,
						"Check microphone permission/device selection and speak before stopping.",
						stderr ? `ffmpeg stderr: ${truncate(stderr, 900)}` : undefined,
					]
						.filter(Boolean)
						.join(" "),
				);
			}
			return audioPath;
		},
		dispose,
	};
};

const checkFfmpeg = async (
	pi: ExtensionAPI,
	cfg: VoiceConfig,
): Promise<ExecResult> => {
	let result: ExecResult;
	try {
		result = await pi.exec(cfg.ffmpegPath, ["-version"], { timeout: 5000 });
	} catch (error) {
		throw new Error(
			`ffmpeg is unavailable at ${cfg.ffmpegPath}: ${formatError(error)}. Install/configure ffmpeg, or set PI_VOICE_FFMPEG.`,
		);
	}
	if (result.code !== 0) {
		throw new Error(
			`ffmpeg check failed at ${cfg.ffmpegPath}: ${truncate(result.stderr || result.stdout || `exit ${result.code}`, 900)}. Install/configure ffmpeg, or set PI_VOICE_FFMPEG.`,
		);
	}
	return result;
};

const checkRuntimeFetchApis = () => {
	const missing = ["fetch", "FormData", "Blob"].filter(
		(name) => typeof (globalThis as any)[name] !== "function",
	);
	if (missing.length > 0) {
		throw new Error(
			`Pi Node runtime is missing ${missing.join(", ")}; openai-compatible transcription cannot run without adding dependencies`,
		);
	}
};

const ensureCloudBackendReady = (cfg: VoiceConfig) => {
	if (!cfg.backendExplicit) {
		throw new Error(
			"Cloud transcription requires explicit PI_VOICE_BACKEND=openai-compatible",
		);
	}
	const endpoint = assertSafeEndpoint(cfg.endpoint);
	checkRuntimeFetchApis();
	if (requiresAuthForEndpoint(endpoint) && !cfg.apiKey) {
		throw new Error(
			`PI_VOICE_API_KEY or OPENAI_API_KEY is required for ${endpoint.host}; loopback endpoints may omit a key`,
		);
	}
};

const detectWhisperCliProfile = async (
	pi: ExtensionAPI,
	cfg: VoiceConfig,
): Promise<WhisperCliProfile> => {
	let help: ExecResult;
	try {
		help = await pi.exec(cfg.whisperBin, ["--help"], { timeout: 20_000 });
	} catch (error) {
		throw new Error(
			`whisper-cli is unavailable at ${cfg.whisperBin}: ${formatError(error)}. Install whisper.cpp or set PI_VOICE_WHISPER_BIN.`,
		);
	}
	const combinedHelp = `${help.stdout}\n${help.stderr}`;
	if (help.code !== 0 && combinedHelp.trim().length === 0) {
		throw new Error(
			`whisper-cli --help failed at ${cfg.whisperBin} with exit code ${help.code}. Install whisper.cpp or set PI_VOICE_WHISPER_BIN.`,
		);
	}

	try {
		const modelStat = await stat(cfg.whisperModel);
		if (!modelStat.isFile()) throw new Error("not a file");
	} catch {
		throw new Error(
			`Whisper model not found at ${cfg.whisperModel}. Download/configure a model and set PI_VOICE_WHISPER_MODEL.`,
		);
	}

	const textOutputFlag = combinedHelp.includes("--output-txt")
		? "--output-txt"
		: combinedHelp.includes("-otxt")
			? "-otxt"
			: undefined;
	if (!textOutputFlag) {
		throw new Error(
			"Unsupported whisper-cli: help does not list --output-txt or -otxt",
		);
	}

	const outputFileFlag = combinedHelp.includes("--output-file")
		? "--output-file"
		: combinedHelp.includes("-of")
			? "-of"
			: undefined;
	if (!outputFileFlag) {
		throw new Error(
			"Unsupported whisper-cli: help does not list --output-file or -of",
		);
	}

	const noTimestampsFlag = combinedHelp.includes("--no-timestamps")
		? "--no-timestamps"
		: combinedHelp.includes("-nt")
			? "-nt"
			: undefined;
	const warnings = noTimestampsFlag
		? []
		: [
				"whisper-cli help does not list --no-timestamps/-nt; timestamp prefixes will be stripped after transcription",
			];

	return { textOutputFlag, outputFileFlag, noTimestampsFlag, warnings };
};

const preflightStart = async (
	pi: ExtensionAPI,
	cfg: VoiceConfig,
): Promise<void> => {
	await checkFfmpeg(pi, cfg);
	if (cfg.backend === "openai-compatible") {
		ensureCloudBackendReady(cfg);
		return;
	}
	await detectWhisperCliProfile(pi, cfg);
};

const makeAbortError = (message = "Voice transcription cancelled") =>
	new Error(message);

const combineAbortSignals = (signals: AbortSignal[]): AbortSignal => {
	const activeSignals = signals.filter(Boolean);
	const nativeAny = (AbortSignal as any).any;
	if (typeof nativeAny === "function") return nativeAny(activeSignals);
	const controller = new AbortController();
	const abort = () => {
		if (!controller.signal.aborted) controller.abort(makeAbortError());
	};
	for (const signal of activeSignals) {
		if (signal.aborted) {
			abort();
			break;
		}
		signal.addEventListener("abort", abort, { once: true });
	}
	return controller.signal;
};

const transcribeOpenAICompatible = async (
	audioPath: string,
	cfg: VoiceConfig,
	signal: AbortSignal,
): Promise<string> => {
	ensureCloudBackendReady(cfg);
	const endpoint = assertSafeEndpoint(cfg.endpoint);
	const audio = await readFile(audioPath);
	const form = new FormData();
	form.append(
		"file",
		new Blob([audio], { type: "audio/wav" }),
		"recording.wav",
	);
	form.append("model", cfg.model);
	form.append("response_format", cfg.responseFormat);
	if (cfg.language) form.append("language", cfg.language);

	const headers: Record<string, string> = {};
	if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

	const timeoutController = new AbortController();
	const timeout = setTimeout(() => {
		timeoutController.abort(
			makeAbortError(
				`OpenAI-compatible transcription timed out after ${cfg.timeoutMs}ms`,
			),
		);
	}, cfg.timeoutMs);
	const requestSignal = combineAbortSignals([signal, timeoutController.signal]);

	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers,
			body: form,
			signal: requestSignal,
			redirect: "error",
		});
	} catch (error) {
		if (signal.aborted) throw makeAbortError();
		if (timeoutController.signal.aborted) {
			throw new Error(
				`OpenAI-compatible transcription timed out after ${cfg.timeoutMs}ms`,
			);
		}
		throw new Error(
			`OpenAI-compatible transcription request failed: ${formatError(error)}`,
		);
	} finally {
		clearTimeout(timeout);
	}

	const responseBody = await response.text();
	if (!response.ok) {
		const body = truncate(responseBody, 700);
		if (response.status === 401)
			throw new Error(
				`OpenAI-compatible transcription returned 401 Unauthorized from ${endpoint.host}`,
			);
		if (response.status === 429)
			throw new Error(
				`OpenAI-compatible transcription was rate limited by ${endpoint.host}: ${body}`,
			);
		if (response.status >= 500)
			throw new Error(
				`OpenAI-compatible transcription server error ${response.status} from ${endpoint.host}: ${body}`,
			);
		throw new Error(
			`OpenAI-compatible transcription failed with HTTP ${response.status} from ${endpoint.host}: ${body}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(responseBody);
	} catch {
		throw new Error(
			`OpenAI-compatible transcription returned invalid JSON from ${endpoint.host}: ${truncate(responseBody, 700)}`,
		);
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		typeof (parsed as { text?: unknown }).text !== "string"
	) {
		throw new Error(
			`OpenAI-compatible transcription JSON from ${endpoint.host} did not include a text field`,
		);
	}
	const text = (parsed as { text: string }).text.trim();
	if (!text)
		throw new Error(
			"OpenAI-compatible transcription returned an empty transcript",
		);
	return text;
};

const stripTimestampPrefixes = (text: string): string =>
	text
		.split(/\r?\n/)
		.map((line) =>
			line
				.replace(/^\s*\[[0-9:.]+\s*-->\s*[0-9:.]+\]\s*/, "")
				.replace(/^\s*\([0-9:.]+\s*-->\s*[0-9:.]+\)\s*/, "")
				.replace(/^\s*[0-9:.]+\s*-->\s*[0-9:.]+\s*/, ""),
		)
		.join("\n")
		.trim();

const transcribeWhisperCli = async (
	audioPath: string,
	cfg: VoiceConfig,
	profile: WhisperCliProfile,
	signal: AbortSignal,
): Promise<string> => {
	const outputPrefix = join(dirname(audioPath), "transcript");
	const args = [
		"-m",
		cfg.whisperModel,
		"-f",
		audioPath,
		profile.textOutputFlag,
		profile.outputFileFlag,
		outputPrefix,
	];
	if (profile.noTimestampsFlag) args.push(profile.noTimestampsFlag);
	if (cfg.language) args.push("-l", cfg.language);

	let stderr = "";
	let stdout = "";
	let exited = false;
	const child = spawn(cfg.whisperBin, args, {
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => {
		stdout = appendStderr(stdout, chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr = appendStderr(stderr, chunk);
	});

	const exit = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, closeSignal) => {
			exited = true;
			resolve({ code, signal: closeSignal });
		});
	});

	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => {
		if (exited) return;
		child.kill("SIGTERM");
		killTimer = setTimeout(() => {
			if (!exited) child.kill("SIGKILL");
		}, 1000);
	};
	if (signal.aborted) onAbort();
	signal.addEventListener("abort", onAbort, { once: true });

	try {
		const result = await exit;
		if (signal.aborted) throw makeAbortError();
		if (result.code !== 0) {
			throw new Error(
				`whisper-cli failed with exit ${result.code ?? `signal ${result.signal}`}: ${truncate(stderr || stdout, 900)}`,
			);
		}
	} catch (error) {
		if (signal.aborted) throw makeAbortError();
		throw new Error(`whisper-cli transcription failed: ${formatError(error)}`);
	} finally {
		signal.removeEventListener("abort", onAbort);
		if (killTimer) clearTimeout(killTimer);
	}

	let output: string;
	try {
		output = await readFile(`${outputPrefix}.txt`, "utf8");
	} catch (error) {
		throw new Error(
			`whisper-cli did not produce ${outputPrefix}.txt: ${formatError(error)}`,
		);
	}
	const text = stripTimestampPrefixes(output).trim();
	if (!text) throw new Error("whisper-cli returned an empty transcript");
	return text;
};

const transcribeSelectedBackend = async (
	pi: ExtensionAPI,
	audioPath: string,
	cfg: VoiceConfig,
	signal: AbortSignal,
): Promise<string> => {
	if (cfg.backend === "openai-compatible") {
		return transcribeOpenAICompatible(audioPath, cfg, signal);
	}
	const profile = await detectWhisperCliProfile(pi, cfg);
	return transcribeWhisperCli(audioPath, cfg, profile, signal);
};

type LoaderResult =
	| { kind: "ok"; text: string }
	| { kind: "cancelled" }
	| { kind: "error"; error: unknown };

const transcribeWithLoader = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	audioPath: string,
	cfg: VoiceConfig,
	abort: AbortController,
): Promise<string> => {
	const run = () => transcribeSelectedBackend(pi, audioPath, cfg, abort.signal);
	if (!ctx.hasUI || ctx.mode !== "tui") return run();

	const result = await ctx.ui.custom<LoaderResult>(
		(tui, theme, _keybindings, done) => {
			const loader = new BorderedLoader(
				tui,
				theme,
				"Transcribing voice… Esc/Ctrl+C to cancel",
				{
					cancellable: true,
				},
			);
			let settled = false;
			const finish = (value: LoaderResult) => {
				if (settled) return;
				settled = true;
				done(value);
			};
			const cancel = () => {
				if (!abort.signal.aborted) abort.abort(makeAbortError());
				finish({ kind: "cancelled" });
			};
			loader.onAbort = cancel;
			loader.signal.addEventListener("abort", cancel, { once: true });
			abort.signal.addEventListener(
				"abort",
				() => finish({ kind: "cancelled" }),
				{ once: true },
			);

			run()
				.then((text) => finish({ kind: "ok", text }))
				.catch((error) =>
					finish(
						abort.signal.aborted
							? { kind: "cancelled" }
							: { kind: "error", error },
					),
				);

			return loader;
		},
	);

	if (result.kind === "ok") return result.text;
	if (result.kind === "cancelled") throw makeAbortError();
	throw result.error;
};

const formatTranscriptForEditor = (text: string, cfg: VoiceConfig): string => {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return cfg.trailingSpace && collapsed.length > 0
		? `${collapsed} `
		: collapsed;
};

const insertTranscript = (
	ctx: ExtensionContext,
	text: string,
	cfg: VoiceConfig,
) => {
	const formatted = formatTranscriptForEditor(text, cfg);
	if (!formatted) throw new Error("Transcript is empty after formatting");
	if (cfg.insertMode === "append") {
		const current = ctx.ui.getEditorText();
		const needsSpace =
			current.length > 0 && !/\s$/.test(current) && !/^\s/.test(formatted);
		ctx.ui.setEditorText(`${current}${needsSpace ? " " : ""}${formatted}`);
		return;
	}
	ctx.ui.pasteToEditor(formatted);
};

const cancelActive = async (
	reason: string,
	ctx?: ExtensionContext,
	options: { notifyWhenIdle?: boolean } = {},
): Promise<boolean> => {
	const current = state;
	if (!current) {
		if (options.notifyWhenIdle && ctx)
			notify(ctx, "No active voice recording or transcription.", "info");
		return false;
	}
	state = undefined;
	clearVoiceUi(ctx);
	if (current.kind === "recording") {
		clearTimeout(current.timeout);
		await current.recorder.dispose();
		if (ctx) notify(ctx, `Voice recording discarded (${reason}).`, "info");
		return true;
	}
	if (!current.abort.signal.aborted)
		current.abort.abort(makeAbortError(reason));
	await current.cleanup();
	if (ctx)
		notify(
			ctx,
			`Voice transcription cancelled (${reason}); temp audio deleted.`,
			"info",
		);
	return true;
};

const expireRecording = async (
	recording: RecordingState,
	ctx: ExtensionContext,
) => {
	if (state !== recording) return;
	state = undefined;
	clearTimeout(recording.timeout);
	await recording.recorder.dispose();
	const message = `Voice recording exceeded ${recording.cfg.maxSeconds}s and was discarded without transcription.`;
	let notified = false;
	try {
		clearVoiceUi(ctx);
		if (ctx.hasUI) {
			notify(ctx, message, "warning");
			notified = true;
		}
	} catch {
		// If the original UI context is no longer valid, report on the next /voice command.
	}
	if (!notified) idleNotice = message;
};

const isCommandContextIdle = (ctx: ExtensionContext): boolean => {
	const maybeIsIdle = (ctx as ExtensionContext & { isIdle?: () => boolean })
		.isIdle;
	return typeof maybeIsIdle === "function" ? maybeIsIdle.call(ctx) : true;
};

const startRecording = async (pi: ExtensionAPI, ctx: ExtensionContext) => {
	if (ctx.mode !== "tui") {
		notify(
			ctx,
			"/voice recording requires interactive Pi TUI mode so the transcript can be inserted into the prompt editor.",
			"error",
		);
		return;
	}
	if (!isCommandContextIdle(ctx)) {
		notify(
			ctx,
			"/voice can only start recording while Pi is idle. Wait for the current agent turn to finish, then run /voice again.",
			"warning",
		);
		return;
	}

	let cfg: VoiceConfig;
	try {
		cfg = loadConfig();
		await preflightStart(pi, cfg);
	} catch (error) {
		notify(ctx, `Voice preflight failed: ${formatError(error)}`, "error");
		return;
	}

	const privacyLabel = privacyLabelForConfig(cfg);
	let recorder: FfmpegRecorder;
	try {
		recorder = await startFfmpegCapture(cfg);
	} catch (error) {
		notify(
			ctx,
			`Could not start voice recording: ${formatError(error)}`,
			"error",
		);
		return;
	}

	const startedAt = Date.now();
	const recording: RecordingState = {
		kind: "recording",
		recorder,
		startedAt,
		deadlineAt: startedAt + cfg.maxSeconds * 1000,
		timeout: undefined as unknown as ReturnType<typeof setTimeout>,
		backend: cfg.backend,
		privacyLabel,
		cfg,
	};
	recording.timeout = setTimeout(() => {
		void expireRecording(recording, ctx);
	}, cfg.maxSeconds * 1000);
	if (typeof (recording.timeout as any).unref === "function")
		(recording.timeout as any).unref();
	state = recording;
	setRecordingUi(ctx, cfg, privacyLabel);
	notify(
		ctx,
		cfg.backend === "openai-compatible"
			? `Voice recording started. Stopping will upload audio to ${endpointHostForUi(cfg.endpoint)}. Use /voice or /voice stop when done.`
			: "Voice recording started locally. Use /voice or /voice stop when done.",
		"info",
	);
};

const stopRecordingAndTranscribe = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
) => {
	const current = state;
	if (!current) {
		notify(
			ctx,
			"No voice recording is active. Use /voice to start recording.",
			"info",
		);
		return;
	}
	if (current.kind === "transcribing") {
		notify(
			ctx,
			"Voice transcription is already running. Use /voice cancel to abort.",
			"warning",
		);
		return;
	}
	if (current.stopping) {
		notify(ctx, "Voice recording is already stopping.", "warning");
		return;
	}
	current.stopping = true;
	clearTimeout(current.timeout);
	if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, "Stopping voice recording…");

	let audioPath: string;
	try {
		audioPath = await current.recorder.stop(current.cfg);
	} catch (error) {
		if (state === current) state = undefined;
		await current.recorder.dispose();
		clearVoiceUi(ctx);
		notify(ctx, `Voice recording failed: ${formatError(error)}`, "error");
		return;
	}

	if (state !== current) {
		await current.recorder.dispose();
		return;
	}

	const abort = new AbortController();
	const token = Symbol("voice-transcription");
	const transcribing: TranscribingState = {
		kind: "transcribing",
		token,
		abort,
		backend: current.backend,
		audioPath,
		cleanup: current.recorder.dispose,
	};
	state = transcribing;
	setTranscribingUi(ctx, current.privacyLabel);

	try {
		const transcript = await transcribeWithLoader(
			pi,
			ctx,
			audioPath,
			current.cfg,
			abort,
		);
		const stillCurrent =
			state?.kind === "transcribing" &&
			state.token === token &&
			!abort.signal.aborted;
		if (!stillCurrent) return;
		insertTranscript(ctx, transcript, current.cfg);
		notify(
			ctx,
			`Inserted transcript (${formatTranscriptForEditor(transcript, current.cfg).length} chars). Review before sending.`,
			"info",
		);
	} catch (error) {
		const stillCurrent =
			state?.kind === "transcribing" && state.token === token;
		if (abort.signal.aborted) {
			if (stillCurrent)
				notify(ctx, "Voice transcription cancelled. No text inserted.", "info");
		} else {
			notify(ctx, `Voice transcription failed: ${formatError(error)}`, "error");
		}
	} finally {
		await current.recorder.dispose();
		if (state?.kind === "transcribing" && state.token === token)
			state = undefined;
		if (pushToTalk.active) setPushToTalkUi(ctx);
		else clearVoiceUi(ctx);
	}
};

const clearPushToTalkReleaseTimer = () => {
	if (!pushToTalk.releaseTimer) return;
	clearTimeout(pushToTalk.releaseTimer);
	pushToTalk.releaseTimer = undefined;
};

const setPushToTalkUi = (ctx: ExtensionContext) => {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(EXTENSION_ID, "Hold Space to record");
	ctx.ui.setWidget(EXTENSION_ID, [
		"🎙️ Voice ready",
		"Hold Space to record; release Space to transcribe into the prompt.",
		"Type /voice again to exit. Esc cancels only the current recording/transcription.",
	]);
	startVoiceVisualizer(ctx, "ready · waiting for Space");
};

const activatePushToTalkMode = (ctx: ExtensionContext) => {
	if (ctx.mode !== "tui") {
		notify(ctx, "/voice mode requires interactive Pi TUI mode.", "error");
		return;
	}
	pushToTalk.releaseMs = parsePositiveInteger(
		"PI_VOICE_SPACE_RELEASE_MS",
		850,
		100,
	);
	pushToTalk.active = true;
	pushToTalk.starting = false;
	clearPushToTalkReleaseTimer();
	ctx.ui.setEditorText("");
	setPushToTalkUi(ctx);
	notify(
		ctx,
		`Voice mode ready. Hold Space to record; release for about ${pushToTalk.releaseMs}ms to transcribe.`,
		"info",
	);
};

const deactivatePushToTalkMode = (ctx?: ExtensionContext) => {
	pushToTalk.active = false;
	pushToTalk.starting = false;
	clearPushToTalkReleaseTimer();
	if (!state) clearVoiceUi(ctx);
};

const schedulePushToTalkRelease = (pi: ExtensionAPI, ctx: ExtensionContext) => {
	clearPushToTalkReleaseTimer();
	pushToTalk.releaseTimer = setTimeout(() => {
		pushToTalk.releaseTimer = undefined;
		if (state?.kind !== "recording") {
			if (pushToTalk.active) setPushToTalkUi(ctx);
			return;
		}
		void stopRecordingAndTranscribe(pi, ctx);
	}, pushToTalk.releaseMs);
	if (typeof (pushToTalk.releaseTimer as any).unref === "function")
		(pushToTalk.releaseTimer as any).unref();
};

const handlePushToTalkSpace = (pi: ExtensionAPI, ctx: ExtensionContext) => {
	if (!pushToTalk.active) return;
	if (state?.kind === "transcribing") return;
	if (state?.kind === "recording") {
		schedulePushToTalkRelease(pi, ctx);
		return;
	}
	if (pushToTalk.starting) return;
	pushToTalk.starting = true;
	void startRecording(pi, ctx)
		.then(() => {
			if (state?.kind === "recording") schedulePushToTalkRelease(pi, ctx);
			else if (pushToTalk.active) setPushToTalkUi(ctx);
		})
		.finally(() => {
			pushToTalk.starting = false;
		});
};

const handlePushToTalkEscape = (ctx: ExtensionContext) => {
	void cancelActive("voice recording cancelled", ctx).finally(() => {
		if (pushToTalk.active) setPushToTalkUi(ctx);
	});
};

const showStatus = (ctx: ExtensionCommandContext) => {
	const current = state;
	if (!current) {
		notify(
			ctx,
			pushToTalk.active
				? "Voice mode is ready. Hold Space to record; release Space to transcribe. Type /voice again to exit."
				: "Voice is idle. Use /voice for hold-Space voice mode, /voice start for immediate recording, or /voice doctor to check setup.",
			"info",
		);
		return;
	}
	if (current.kind === "recording") {
		const elapsed = Math.max(
			0,
			Math.round((Date.now() - current.startedAt) / 1000),
		);
		const remaining = Math.max(
			0,
			Math.round((current.deadlineAt - Date.now()) / 1000),
		);
		notify(
			ctx,
			`Voice recording: ${elapsed}s elapsed, ${remaining}s until discard timeout. Backend: ${current.privacyLabel}.`,
			"info",
		);
		return;
	}
	notify(
		ctx,
		`Voice transcription in progress via ${current.backend}. Use /voice cancel to abort.`,
		"info",
	);
};

const showHelp = (ctx: ExtensionCommandContext) => {
	notify(
		ctx,
		[
			"/voice toggles persistent hold-Space voice mode. Hold Space to record; release Space to transcribe into the prompt editor. Voice mode stays enabled until you type /voice again. It never submits the prompt.",
			"",
			"Commands:",
			"  /voice or /voice toggle  Toggle hold-Space voice mode; enabling clears the prompt.",
			"  /voice start            Start recording immediately without hold-Space mode.",
			"  /voice stop             Stop, transcribe, and insert.",
			"  /voice off              Exit voice mode and discard active audio if needed.",
			"  /voice cancel           Discard active recording or abort transcription; voice mode remains ready.",
			"  /voice status           Show current voice state.",
			"  /voice doctor           Check ffmpeg and selected transcription backend.",
			"  /voice devices          List macOS ffmpeg avfoundation audio devices.",
			"  /voice help             Show this help.",
			"",
			"Privacy:",
			"  Default backend is PI_VOICE_BACKEND=whisper-cli (local only). OPENAI_API_KEY is ignored unless you explicitly set PI_VOICE_BACKEND=openai-compatible.",
			"  Cloud upload happens only with explicit PI_VOICE_BACKEND=openai-compatible; stopping will upload audio to the configured endpoint host.",
			"  Temp WAV files are deleted on stop, cancel, error, timeout, reload, shutdown, or agent start.",
			"",
			"Common env vars:",
			"  PI_VOICE_BACKEND=whisper-cli|openai-compatible",
			"  PI_VOICE_FFMPEG=ffmpeg  PI_VOICE_FFMPEG_INPUT=:0  PI_VOICE_MAX_SECONDS=120",
			"  PI_VOICE_SPACE_RELEASE_MS=850  # release is detected by key-repeat pause",
			"  PI_VOICE_WHISPER_BIN=whisper-cli  PI_VOICE_WHISPER_MODEL=~/.pi/models/ggml-base.en.bin",
			"  PI_VOICE_ENDPOINT=https://api.openai.com/v1/audio/transcriptions  PI_VOICE_MODEL=whisper-1",
			"  PI_VOICE_INSERT_MODE=paste|append  PI_VOICE_TRAILING_SPACE=1",
		].join("\n"),
		"info",
	);
};

const summarizeExecVersion = (result: ExecResult): string => {
	const firstLine = (result.stdout || result.stderr)
		.split(/\r?\n/)
		.find((line) => line.trim());
	return truncate(firstLine ?? "ok", 140);
};

const runDoctor = async (pi: ExtensionAPI, ctx: ExtensionCommandContext) => {
	let cfg: VoiceConfig;
	try {
		cfg = loadConfig();
	} catch (error) {
		notify(ctx, `Voice config error: ${formatError(error)}`, "error");
		return;
	}

	const lines: DoctorLine[] = [];
	lines.push({
		ok: true,
		text: `Backend: ${cfg.backend}${cfg.backendExplicit ? " (explicit)" : " (default local)"}`,
	});
	lines.push({
		ok: true,
		text: `Capture: ${cfg.ffmpegPath} -f ${cfg.ffmpegFormat} -i ${cfg.ffmpegInput}`,
	});
	lines.push({
		ok: true,
		text: `Max recording: ${cfg.maxSeconds}s; minimum WAV size: ${cfg.minBytes} bytes`,
	});

	try {
		const ffmpeg = await checkFfmpeg(pi, cfg);
		lines.push({ ok: true, text: `ffmpeg: ${summarizeExecVersion(ffmpeg)}` });
	} catch (error) {
		lines.push({
			ok: false,
			text: `ffmpeg unavailable: ${formatError(error)}`,
		});
		lines.push({
			ok: "warn",
			text: "Setup: install ffmpeg yourself (for example, brew install ffmpeg) or set PI_VOICE_FFMPEG.",
		});
	}

	if (cfg.backend === "openai-compatible") {
		try {
			ensureCloudBackendReady(cfg);
			const endpoint = assertSafeEndpoint(cfg.endpoint);
			lines.push({
				ok: true,
				text: `Endpoint: ${endpoint.protocol}//${endpoint.host} (safe)`,
			});
			lines.push({
				ok: true,
				text: requiresAuthForEndpoint(endpoint)
					? "API key: present (value hidden)"
					: "API key: optional for loopback endpoint",
			});
			lines.push({
				ok: "warn",
				text: `Stopping will upload audio to ${endpoint.host}.`,
			});
		} catch (error) {
			lines.push({
				ok: false,
				text: `openai-compatible unavailable: ${formatError(error)}`,
			});
		}
	} else {
		try {
			const profile = await detectWhisperCliProfile(pi, cfg);
			lines.push({ ok: true, text: `whisper-cli: ${cfg.whisperBin}` });
			lines.push({ ok: true, text: `whisper model: ${cfg.whisperModel}` });
			lines.push({
				ok: true,
				text: `whisper flags: ${profile.textOutputFlag}, ${profile.outputFileFlag}${profile.noTimestampsFlag ? `, ${profile.noTimestampsFlag}` : ""}`,
			});
			for (const warning of profile.warnings)
				lines.push({ ok: "warn", text: warning });
		} catch (error) {
			lines.push({
				ok: false,
				text: `whisper-cli unavailable: ${formatError(error)}`,
			});
			lines.push({
				ok: "warn",
				text: "Setup: install whisper.cpp/whisper-cli yourself and set PI_VOICE_WHISPER_MODEL to an existing model file.",
			});
		}
		if (process.env.OPENAI_API_KEY) {
			lines.push({
				ok: "warn",
				text: "OPENAI_API_KEY is set but ignored because PI_VOICE_BACKEND is local; set PI_VOICE_BACKEND=openai-compatible to opt into cloud upload.",
			});
		}
	}

	lines.push({
		ok: true,
		text: `Editor insert mode: ${cfg.insertMode}; trailing space: ${cfg.trailingSpace ? "enabled" : "disabled"}`,
	});

	const failed = lines.some((line) => line.ok === false);
	const body = lines
		.map(
			(line) =>
				`${line.ok === true ? "✓" : line.ok === "warn" ? "!" : "✗"} ${line.text}`,
		)
		.join("\n");
	notify(
		ctx,
		`Voice doctor${failed ? " found issues" : " passed"}:\n${body}`,
		failed ? "warning" : "info",
	);
};

const listDevices = async (pi: ExtensionAPI, ctx: ExtensionCommandContext) => {
	let cfg: VoiceConfig;
	try {
		cfg = loadConfig();
	} catch (error) {
		notify(ctx, `Voice config error: ${formatError(error)}`, "error");
		return;
	}
	if (platform() !== "darwin") {
		notify(
			ctx,
			"/voice devices currently lists macOS avfoundation devices only. Configure PI_VOICE_FFMPEG_FORMAT/INPUT manually on this platform.",
			"warning",
		);
		return;
	}
	try {
		await checkFfmpeg(pi, cfg);
	} catch (error) {
		notify(
			ctx,
			`Cannot list devices because ffmpeg is unavailable: ${formatError(error)}`,
			"error",
		);
		return;
	}
	let result: ExecResult;
	try {
		result = await pi.exec(
			cfg.ffmpegPath,
			["-f", "avfoundation", "-list_devices", "true", "-i", ""],
			{
				timeout: 8000,
			},
		);
	} catch (error) {
		notify(ctx, `ffmpeg device listing failed: ${formatError(error)}`, "error");
		return;
	}
	const combined = `${result.stderr}\n${result.stdout}`.trim();
	const audioLines = combined
		.split(/\r?\n/)
		.filter(
			(line) =>
				/AVFoundation audio devices|\[[0-9]+\].*/i.test(line) ||
				/audio/i.test(line),
		);
	notify(
		ctx,
		`ffmpeg avfoundation devices (set PI_VOICE_FFMPEG_INPUT to the audio index, e.g. :0):\n${truncate((audioLines.length > 0 ? audioLines : combined.split(/\r?\n/)).join("\n"), 3000)}`,
		"info",
	);
};

const parseCommand = (args: string): string => {
	const command = args.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase();
	return command || "toggle";
};

const handleVoiceCommand = async (
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
) => {
	flushIdleNotice(ctx);
	const command = parseCommand(args);
	if (command === "help" || command === "--help" || command === "-h") {
		showHelp(ctx);
		return;
	}
	if (command === "doctor") {
		await runDoctor(pi, ctx);
		return;
	}
	if (command === "devices") {
		await listDevices(pi, ctx);
		return;
	}
	if (command === "status") {
		showStatus(ctx);
		return;
	}
	if (command === "cancel") {
		const cancelled = await cancelActive("user cancelled", ctx, {
			notifyWhenIdle: !pushToTalk.active,
		});
		if (pushToTalk.active) {
			deactivatePushToTalkMode(ctx);
			notify(
				ctx,
				cancelled ? "Voice mode cancelled." : "Voice mode off.",
				"info",
			);
		}
		return;
	}
	if (command === "off" || command === "exit") {
		await cancelActive("voice mode exited", ctx);
		deactivatePushToTalkMode(ctx);
		notify(ctx, "Voice mode off.", "info");
		return;
	}
	if (command === "stop") {
		deactivatePushToTalkMode(ctx);
		await stopRecordingAndTranscribe(pi, ctx);
		return;
	}
	if (command === "start") {
		deactivatePushToTalkMode(ctx);
		await startRecording(pi, ctx);
		return;
	}
	if (command === "toggle" || command === "mode" || command === "hold") {
		if (state?.kind === "recording") {
			deactivatePushToTalkMode(ctx);
			await stopRecordingAndTranscribe(pi, ctx);
			return;
		}
		if (state?.kind === "transcribing") {
			notify(
				ctx,
				"Voice transcription is running. Use /voice cancel to abort.",
				"warning",
			);
			return;
		}
		if (pushToTalk.active) {
			deactivatePushToTalkMode(ctx);
			notify(ctx, "Voice mode off.", "info");
			return;
		}
		activatePushToTalkMode(ctx);
		return;
	}
	notify(
		ctx,
		`Unknown /voice subcommand: ${command}. Try /voice help.`,
		"warning",
	);
};

const getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
	const normalized = prefix.trim().toLowerCase();
	const items = COMMANDS.filter((command) =>
		command.startsWith(normalized),
	).map((command) => ({
		value: command,
		label: command,
	}));
	return items.length > 0 ? items : null;
};

export default function voiceExtension(pi: ExtensionAPI) {
	let previousEditorFactory:
		| ReturnType<ExtensionContext["ui"]["getEditorComponent"]>
		| undefined;

	pi.registerCommand("voice", {
		description:
			"Hold Space to record microphone audio, transcribe it, and insert the transcript into the prompt editor",
		getArgumentCompletions,
		handler: async (args, ctx) => {
			await handleVoiceCommand(pi, args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		previousEditorFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent(
			createPushToTalkEditorFactory(previousEditorFactory, {
				ctx,
				isActive: () => pushToTalk.active,
				onSpace: (handlerCtx) => handlePushToTalkSpace(pi, handlerCtx),
				onEscape: handlePushToTalkEscape,
			}),
		);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		deactivatePushToTalkMode(ctx);
		await cancelActive("agent turn started", ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		deactivatePushToTalkMode(ctx);
		await cancelActive("agent turn started", ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		deactivatePushToTalkMode(ctx);
		if (ctx.mode === "tui") ctx.ui.setEditorComponent(previousEditorFactory);
		previousEditorFactory = undefined;
		await cancelActive("session shutdown", ctx);
	});
}
