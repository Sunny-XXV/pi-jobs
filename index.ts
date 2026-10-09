import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseJobsCommand, jobsCommandUsage } from "./src/command.mjs";
import { formatDetails, formatEvent, formatList } from "./src/format.mjs";
import { NotificationLedger } from "./src/notifications.mjs";
import { JobRegistry } from "./src/registry.mjs";
import { ServiceManager } from "./src/service-manager.mjs";
import { ensurePrivateDirectory, sessionPaths, TERMINAL_STATUSES } from "./src/store.mjs";

type Job = {
	id: string;
	parentId?: string;
	label: string;
	mode: "run" | "watch";
	status: "queued" | "running" | "waiting" | "stopping" | "completed" | "failed" | "timed_out" | "stopped";
	command: string;
	cwd: string;
	intervalMs?: number;
	timeoutMs?: number;
	checkTimeoutMs?: number;
	maxAttempts?: number;
	terminateTurn?: boolean;
	ownerPid?: number;
	attempts: number;
	createdAt: number;
	startedAt?: number;
	deadlineAt: number;
	finishedAt?: number;
	nextAttemptAt?: number;
	runnerPid?: number;
	pid?: number;
	lastCode?: number | null;
	lastSignal?: string;
	lastStdout?: string;
	lastStderr?: string;
	runnerStderr?: string;
	error?: string;
	eventSeq?: number;
};

const Params = Type.Object({
	action: Type.Union([
		Type.Literal("run"),
		Type.Literal("watch"),
		Type.Literal("list"),
		Type.Literal("show"),
		Type.Literal("stop"),
		Type.Literal("retry"),
		Type.Literal("remove"),
	]),
	command: Type.Optional(Type.String({ description: "Bash command for run/watch" })),
	label: Type.Optional(Type.String({ description: "Short human-readable job label" })),
	id: Type.Optional(Type.String({ description: "Job id; stop accepts all and remove accepts finished" })),
	cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the Pi session cwd" })),
	interval_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 3600, description: "watch only: delay between attempts; default 30" })),
	timeout_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 604800, description: "Overall deadline; run defaults to 86400, watch to 3600" })),
	attempt_timeout_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 86400, description: "watch only: timeout for each attempt; default 60" })),
	max_attempts: Type.Optional(Type.Number({ minimum: 1, maximum: 100000, description: "watch only: maximum attempts; default 1000" })),
	terminate_turn: Type.Optional(Type.Boolean({ description: "Stop the current model turn after starting; default true" })),
});

function seconds(value: number | undefined, fallback: number): number {
	return Math.round((value ?? fallback) * 1000);
}

function elapsed(job: Job): string {
	const seconds = Math.max(0, Math.round(((job.finishedAt ?? Date.now()) - job.createdAt) / 1000));
	if (seconds < 60) return seconds + "s";
	if (seconds < 3600) return Math.floor(seconds / 60) + "m" + String(seconds % 60).padStart(2, "0") + "s";
	return Math.floor(seconds / 3600) + "h" + String(Math.floor(seconds / 60) % 60).padStart(2, "0") + "m";
}

function statusColor(status: Job["status"]): "accent" | "success" | "warning" | "error" | "dim" {
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	if (status === "timed_out" || status === "stopped") return "warning";
	if (status === "waiting") return "dim";
	return "accent";
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(1, width));
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function divider(width: number): string {
	return "─".repeat(Math.max(1, width));
}

function renderPanel(lines: string[], width: number, height: number): string[] {
	const result = lines.slice(0, height).map((line) => fit(line, width));
	while (result.length < height) result.push(" ".repeat(width));
	return result;
}

function terminal(job: Job): boolean {
	return TERMINAL_STATUSES.has(job.status);
}

async function openJobsDashboard(registry: JobRegistry, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(formatList(registry.list()), "info");
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let jobs = registry.list() as Job[];
		let selected = 0;
		let filter: "all" | "active" | "finished" = "all";
		let outputOffset = 0;
		let follow = true;
		let confirm: "stop" | "remove" | "retry" | undefined;
		let notice = "";
		let maxOutputOffset = 0;

		const filtered = () => jobs.filter((job) => filter === "all" || (filter === "active" ? !terminal(job) : terminal(job)));
		const current = () => {
			const visible = filtered();
			selected = Math.max(0, Math.min(selected, Math.max(0, visible.length - 1)));
			return visible[selected];
		};
		const refresh = () => {
			jobs = registry.list() as Job[];
			current();
			tui.requestRender();
		};
		const timer = setInterval(refresh, 300);
		timer.unref?.();

		return {
			render(width: number): string[] {
				const renderWidth = Math.max(24, width);
				const visible = filtered();
				const job = current();
				const active = jobs.filter((item) => !terminal(item)).length;
				const header = theme.fg("accent", theme.bold("Pi Jobs")) + theme.fg("dim", `  ${active} active · ${jobs.length} total · ${filter}`);
				const help = confirm
					? theme.fg("warning", `Confirm ${confirm}?  y yes · any other key cancel`)
					: theme.fg("dim", "↑↓/jk select · tab filter · f follow · r retry · x stop · d remove · q close");
				const listLines = visible.length ? visible.map((item, index) => {
					const marker = index === selected ? "› " : "  ";
					const line = `${marker}${item.id}  ${item.mode.padEnd(5)} ${item.status.padEnd(9)} ${String(item.attempts).padStart(3)}x  ${elapsed(item)}  ${item.label}`;
					return index === selected ? theme.fg("accent", theme.bold(line)) : theme.fg(statusColor(item.status), line);
				}) : [theme.fg("dim", "No jobs in this view")];

				const detailLines = job ? formatDetails(job).split("\n") : ["Select a job to inspect it."];
				const outputStart = detailLines.findIndex((line) => line === "stdout:");
				const metadata = outputStart >= 0 ? detailLines.slice(0, outputStart) : detailLines;
				const output = outputStart >= 0 ? detailLines.slice(outputStart) : [];
				const bodyHeight = 20;
				maxOutputOffset = Math.max(0, output.length - Math.max(4, bodyHeight - metadata.length - 2));
				if (follow) outputOffset = maxOutputOffset;
				outputOffset = Math.max(0, Math.min(outputOffset, maxOutputOffset));
				const shownDetail = [...metadata, ...output.slice(outputOffset, outputOffset + Math.max(4, bodyHeight - metadata.length - 2))]
					.flatMap((line) => wrapTextWithAnsi(line, renderWidth >= 96 ? Math.floor(renderWidth * 0.58) - 3 : renderWidth));

				let body: string[];
				if (renderWidth >= 96) {
					const leftWidth = Math.max(36, Math.floor(renderWidth * 0.42));
					const rightWidth = renderWidth - leftWidth - 3;
					const left = renderPanel([theme.fg("dim", "JOBS"), ...listLines], leftWidth, bodyHeight);
					const right = renderPanel([theme.fg("dim", job ? `DETAIL · ${job.id}${follow ? " · following" : ""}` : "DETAIL"), ...shownDetail], rightWidth, bodyHeight);
					body = left.map((line, index) => line + theme.fg("dim", " │ ") + right[index]);
				} else {
					body = [theme.fg("dim", "JOBS"), ...listLines.slice(Math.max(0, selected - 3), selected + 4), theme.fg("dim", divider(renderWidth)), ...shownDetail].slice(0, bodyHeight + 6);
				}
				return [fit(header, renderWidth), theme.fg("dim", divider(renderWidth)), ...body.map((line) => truncateToWidth(line, renderWidth)), theme.fg("dim", divider(renderWidth)), fit(notice || help, renderWidth)];
			},
			invalidate(): void {},
			handleInput(data: string): void {
				const job = current();
				if (confirm) {
					const action = confirm;
					confirm = undefined;
					if (data.toLowerCase() === "y" && job) {
						try {
							if (action === "stop") notice = registry.stop(job.id) ? "Stop requested for " + job.id : "Job is no longer active";
							else if (action === "remove") notice = registry.remove(job.id) ? "Removed " + job.id : "Only finished jobs can be removed";
							else {
								const retried = registry.retry(job.id) as Job;
								notice = `Started ${retried.id} from ${job.id}`;
							}
						} catch (error) { notice = String((error as Error)?.message ?? error); }
						refresh();
					}
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return done(undefined);
				if (matchesKey(data, "up") || data === "k") { selected = Math.max(0, selected - 1); follow = true; notice = ""; }
				else if (matchesKey(data, "down") || data === "j") { selected = Math.min(Math.max(0, filtered().length - 1), selected + 1); follow = true; notice = ""; }
				else if (matchesKey(data, "tab")) { filter = filter === "all" ? "active" : filter === "active" ? "finished" : "all"; selected = 0; follow = true; }
				else if (data === "f") { follow = !follow; if (follow) outputOffset = maxOutputOffset; }
				else if (matchesKey(data, "pageup")) { follow = false; outputOffset = Math.max(0, outputOffset - 8); }
				else if (matchesKey(data, "pagedown")) { outputOffset = Math.min(maxOutputOffset, outputOffset + 8); follow = outputOffset === maxOutputOffset; }
				else if (data === "x" && job && !terminal(job)) confirm = "stop";
				else if (data === "d" && job && terminal(job)) confirm = "remove";
				else if (data === "r" && job && terminal(job)) confirm = "retry";
				tui.requestRender();
			},
			dispose(): void { clearInterval(timer); },
		};
	});
}

export default function jobsExtension(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	let registry: JobRegistry | undefined;
	let ledger: NotificationLedger | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let delivering = false;

	const requireRegistry = () => {
		if (!registry) throw new Error("Pi Jobs is not attached to a session");
		return registry;
	};

	const updateStatus = () => {
		if (!currentCtx?.hasUI || !registry) return;
		const active = (registry.list() as Job[]).filter((job) => !terminal(job)).length;
		currentCtx.ui.setStatus("jobs", active ? currentCtx.ui.theme.fg("accent", "jobs:" + active) : undefined);
	};

	const deliverEvents = async () => {
		if (delivering || !currentCtx || !registry || !ledger) return;
		delivering = true;
		try {
			updateStatus();
			for (const job of ledger.pending(registry.list() as Job[])) {
				const message = { customType: "job-event", content: formatEvent(job), display: true, details: job };
				if (currentCtx.isIdle()) {
					try { pi.sendMessage(message, { triggerTurn: true }); }
					catch { pi.sendMessage(message, { triggerTurn: true, deliverAs: job.terminateTurn === false ? "steer" : "followUp" }); }
				} else {
					pi.sendMessage(message, { triggerTurn: true, deliverAs: job.terminateTurn === false ? "steer" : "followUp" });
				}
				ledger.ack(job);
			}
		} finally { delivering = false; }
	};

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		const sessionId = ctx.sessionManager.getSessionId();
		const paths = sessionPaths(sessionId);
		ensurePrivateDirectory(paths.jobsDirectory);
		const serviceManager = new ServiceManager({ sessionId, sessionDirectory: paths.directory });
		registry = new JobRegistry({ sessionDirectory: paths.directory, serviceManager });
		ledger = new NotificationLedger(paths.directory);
		pollTimer = setInterval(() => void deliverEvents(), 750);
		pollTimer.unref?.();
		void deliverEvents();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		if (event.reason !== "reload" && registry) registry.stop("all");
		ctx.ui.setStatus("jobs", undefined);
		currentCtx = undefined;
		registry = undefined;
		ledger = undefined;
	});

	pi.registerMessageRenderer("job-event", (message, { outputPad }, theme) => {
		const job = message.details as Job | undefined;
		const color = statusColor(job?.status ?? "failed");
		const title = job ? `job ${job.status}: ${job.label} (${job.id})` : "job event";
		return {
			render(width: number): string[] {
				const pad = " ".repeat(outputPad);
				return [theme.fg(color, theme.bold(title)), ...String(message.content).split("\n").flatMap((line) => wrapTextWithAnsi(pad + line, width))];
			},
			invalidate(): void {},
		};
	});

	pi.registerTool({
		name: "jobs",
		label: "Jobs",
		description: [
			"Run and manage session-scoped background jobs through launchd on macOS or systemd on Linux. Jobs survive /reload without restarting the command, and are stopped when the owning Pi session ends or is replaced.",
			"Use action=run for one execution, including long-running SQL or builds. A run command is never automatically submitted twice. Use action=watch only for a read-only, idempotent predicate: exit 0 completes; non-zero retries after interval_seconds.",
			"The default terminate_turn=true ends the current model turn after starting; completion wakes the session. Set false only when useful foreground work should continue independently.",
			"Use list/show/stop/retry/remove for management. retry is the only operation that deliberately creates another execution of a finished job.",
		].join(" "),
		parameters: Params,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			const jobs = requireRegistry();
			if (params.action === "list") {
				const items = jobs.list() as Job[];
				return { content: [{ type: "text", text: formatList(items) }], details: { action: "list", items } };
			}
			if (params.action === "show") {
				if (!params.id) throw new Error("id is required for action=show");
				const job = jobs.get(params.id) as Job | undefined;
				return { content: [{ type: "text", text: job ? formatDetails(job) : `Job ${params.id} was not found.` }], details: { action: "show", job } };
			}
			if (params.action === "stop") {
				if (!params.id) throw new Error("id is required for action=stop");
				const count = jobs.stop(params.id);
				return { content: [{ type: "text", text: count ? `Requested stop for ${count} job(s).` : `No active job matched ${params.id}.` }], details: { action: "stop", count } };
			}
			if (params.action === "remove") {
				if (!params.id) throw new Error("id is required for action=remove");
				const count = jobs.remove(params.id);
				if (params.id !== "finished") ledger?.forget(params.id);
				return { content: [{ type: "text", text: count ? `Removed ${count} finished job(s).` : `No finished job matched ${params.id}.` }], details: { action: "remove", count } };
			}
			if (params.action === "retry") {
				if (!params.id) throw new Error("id is required for action=retry");
				const job = jobs.retry(params.id) as Job;
				return { content: [{ type: "text", text: `Started job ${job.id} as an explicit retry of ${params.id}.` }], details: { action: "retry", job } };
			}

			if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("jobs requires a long-lived Pi TUI or RPC session");
			if (!params.command?.trim()) throw new Error("command is required for action=" + params.action);
			const mode = params.action as "run" | "watch";
			const terminateTurn = params.terminate_turn !== false;
			const timeoutMs = seconds(params.timeout_seconds, mode === "watch" ? 3600 : 86400);
			const job = jobs.start({
				mode,
				command: params.command.trim(),
				label: params.label,
				cwd: params.cwd?.trim() || ctx.cwd,
				intervalMs: seconds(params.interval_seconds, 30),
				timeoutMs,
				checkTimeoutMs: mode === "watch" ? seconds(params.attempt_timeout_seconds, 60) : timeoutMs,
				maxAttempts: mode === "watch" ? Math.round(params.max_attempts ?? 1000) : 1,
				terminateTurn,
			}) as Job;
			updateStatus();
			return {
				content: [{ type: "text", text: `Started ${mode} job ${job.id} (${job.label}). It is owned by the OS service manager and will survive /reload without restarting the command.${terminateTurn ? " This turn will now stop; completion will wake the session." : " This turn may continue while it runs."}` }],
				details: { action: mode, job },
				terminate: terminateTurn,
			};
		},
	});

	pi.registerCommand("jobs", {
		description: "Open the background jobs dashboard or manage jobs",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const jobs = requireRegistry();
			const request = parseJobsCommand(args);
			if (request.action === "help") return ctx.ui.notify(jobsCommandUsage(), "warning");
			if (request.action === "list") return openJobsDashboard(jobs, ctx);
			if (request.action === "show") {
				const job = jobs.get(request.id) as Job | undefined;
				return ctx.ui.notify(job ? formatDetails(job) : `Job ${request.id} was not found.`, job ? "info" : "warning");
			}
			if (request.action === "stop") {
				const count = jobs.stop(request.id);
				return ctx.ui.notify(count ? `Requested stop for ${count} job(s).` : `No active job matched ${request.id}.`, count ? "info" : "warning");
			}
			if (request.action === "remove") {
				const count = jobs.remove(request.id);
				return ctx.ui.notify(count ? `Removed ${count} finished job(s).` : `No finished job matched ${request.id}.`, count ? "info" : "warning");
			}
			try {
				const job = jobs.retry(request.id) as Job;
				ctx.ui.notify(`Started ${job.id} as a retry of ${request.id}.`, "info");
			} catch (error) { ctx.ui.notify(String((error as Error)?.message ?? error), "error"); }
		},
	});
}
