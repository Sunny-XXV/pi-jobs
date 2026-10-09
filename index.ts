import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseJobsCommand, jobsCommandUsage } from "./src/command.mjs";
import { formatDetails, formatEvent, formatList } from "./src/format.mjs";
import { NotificationLedger } from "./src/notifications.mjs";
import { JobRegistry } from "./src/registry.mjs";
import { ServiceManager } from "./src/service-manager.mjs";
import { ensurePrivateDirectory, sessionPaths, TERMINAL_STATUSES } from "./src/store.mjs";
import { WakeRuntime } from "./src/wake-runtime.mjs";

type Job = {
	id: string;
	parentId?: string;
	label: string;
	status: "queued" | "running" | "stopping" | "completed" | "failed" | "timed_out" | "stopped";
	command: string;
	cwd: string;
	timeoutMs?: number;
	readiness?: "process" | "signal";
	readyTimeoutMs?: number;
	readinessEvidence?: "process" | "signal" | "terminal";
	terminateTurn?: boolean;
	ownerPid?: number;
	createdAt: number;
	startedAt?: number;
	deadlineAt: number;
	finishedAt?: number;
	runnerPid?: number;
	pid?: number;
	exitCode?: number | null;
	signal?: string;
	lastStdout?: string;
	lastStderr?: string;
	runnerStderr?: string;
	error?: string;
	eventSeq?: number;
	events?: Array<{ sequence: number; type: string; level: "info" | "warning" | "error"; message: string; emittedAt?: number; details?: unknown }>;
};

const IdParams = (action: "show" | "stop" | "retry" | "remove") => Type.Object({
	action: Type.Literal(action),
	id: Type.String({ description: action === "stop" ? "Job id or all" : action === "remove" ? "Job id or finished" : "Job id" }),
});

const Params = Type.Union([
	Type.Object({
		action: Type.Literal("run"),
		command: Type.String({ description: "Bash command to execute once" }),
		label: Type.Optional(Type.String({ description: "Short human-readable job label" })),
		cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the Pi session cwd" })),
		timeout_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 604800, description: "Overall deadline; defaults to 86400" })),
		readiness: Type.Union([
			Type.Literal("process"),
			Type.Literal("signal"),
		], { description: "Required startup evidence before the tool may end the turn. Use process only when a live runner and command PID are sufficient. Use signal for remote submissions and watchdogs; the command must touch $PI_JOB_READY after acceptance or its first successful health check." }),
		ready_timeout_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 3600, description: "Maximum wait for readiness evidence; default 30" })),
		terminate_turn: Type.Optional(Type.Boolean({ description: "Stop the current model turn after readiness is confirmed; default true" })),
	}),
	Type.Object({ action: Type.Literal("list") }),
	IdParams("show"),
	IdParams("stop"),
	IdParams("retry"),
	IdParams("remove"),
]);

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

function messageEvent(event: any) {
	const job = event.job as Job;
	const summary = {
		id: job.id,
		parentId: job.parentId,
		label: job.label,
		status: job.status,
		readiness: job.readiness,
		terminateTurn: job.terminateTurn,
		createdAt: job.createdAt,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		exitCode: job.exitCode,
		signal: job.signal,
		error: job.error,
		eventSeq: job.eventSeq,
		lastStdout: event.kind === "terminal" ? job.lastStdout : undefined,
		lastStderr: event.kind === "terminal" ? job.lastStderr : undefined,
	};
	return event.kind === "signal"
		? { key: event.key, kind: event.kind, id: event.id, sequence: event.sequence, job: summary, signal: event.signal }
		: { key: event.key, kind: event.kind, id: event.id, sequence: event.sequence, job: summary };
}

async function openJobsDashboard(registry: JobRegistry, removeJob: (id: string) => number, ctx: ExtensionContext): Promise<void> {
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
				const renderWidth = Math.max(1, width);
				const visible = filtered();
				const job = current();
				const active = jobs.filter((item) => !terminal(item)).length;
				const header = theme.fg("accent", theme.bold("Pi Jobs")) + theme.fg("dim", `  ${active} active · ${jobs.length} total · ${filter}`);
				const help = confirm
					? theme.fg("warning", `Confirm ${confirm}?  y yes · any other key cancel`)
					: theme.fg("dim", "↑↓/jk select · tab filter · f follow · r retry · x stop · d remove · q close");
				const listHeight = 19;
				const listStart = Math.max(0, Math.min(selected - Math.floor(listHeight / 2), Math.max(0, visible.length - listHeight)));
				const listLines = visible.length ? visible.slice(listStart, listStart + listHeight).map((item, offset) => {
					const index = listStart + offset;
					const marker = index === selected ? "› " : "  ";
					const line = `${marker}${item.id}  ${item.status.padEnd(9)} ${elapsed(item)}  ${item.label}`;
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
							else if (action === "remove") notice = removeJob(job.id) ? "Removed " + job.id : "Only finished jobs can be removed";
							else {
								notice = `Starting retry of ${job.id}…`;
								void registry.retry(job.id).then((retried: Job) => {
									notice = `Started ${retried.id} from ${job.id}`;
									refresh();
								}).catch((error: unknown) => {
									notice = String((error as Error)?.message ?? error);
									tui.requestRender();
								});
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
				else if (matchesKey(data, "pageUp")) { follow = false; outputOffset = Math.max(0, outputOffset - 8); }
				else if (matchesKey(data, "pageDown")) { outputOffset = Math.min(maxOutputOffset, outputOffset + 8); follow = outputOffset === maxOutputOffset; }
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
	let activationTimer: ReturnType<typeof setTimeout> | undefined;
	let deliveryGeneration = 0;
	let deliveryActive = false;
	let delivering = false;
	let wakeRuntime: WakeRuntime | undefined;

	const requireRegistry = () => {
		if (!registry) throw new Error("Pi Jobs is not attached to a session");
		return registry;
	};

	const removeJobs = (id: string) => {
		const jobs = requireRegistry();
		const count = jobs.remove(id);
		if (count && ledger) ledger.prune(jobs.list());
		return count;
	};

	let lastStatusText: string | undefined;
	const updateStatus = () => {
		if (!currentCtx?.hasUI || !registry) return;
		const active = (registry.list() as Job[]).filter((job) => !terminal(job)).length;
		const statusText = active ? currentCtx.ui.theme.fg("accent", "jobs:" + active) : undefined;
		if (statusText === lastStatusText) return;
		lastStatusText = statusText;
		currentCtx.ui.setStatus("jobs", statusText);
	};

	const deliverEvents = async () => {
		if (!deliveryActive || delivering || !currentCtx || !registry || !ledger) return;
		delivering = true;
		try {
			updateStatus();
			const event = ledger.next(registry.list() as Job[], { retryUnstarted: currentCtx.isIdle() });
			if (event && currentCtx && ledger) {
				const job = event.job as Job;
				const message = { customType: "job-event", content: formatEvent(event), display: true, details: { event: messageEvent(event) } };
				try {
					ledger.sent(event);
					if (currentCtx.isIdle()) pi.sendMessage(message, { triggerTurn: true });
					else pi.sendMessage(message, { triggerTurn: true, deliverAs: job.terminateTurn === false ? "steer" : "followUp" });
				} catch (error) {
					ledger.failed(event);
					throw error;
				}
			}
		} catch (error) {
			if (currentCtx) console.error("pi-jobs: failed to deliver job event:", error);
		} finally { delivering = false; }
	};

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		deliveryGeneration += 1;
		deliveryActive = false;
		const sessionId = ctx.sessionManager.getSessionId();
		const paths = sessionPaths(sessionId);
		ensurePrivateDirectory(paths.jobsDirectory);
		const serviceManager = new ServiceManager({ sessionId, sessionDirectory: paths.directory });
		registry = new JobRegistry({ sessionDirectory: paths.directory, serviceManager });
		ledger = new NotificationLedger(paths.directory);
		wakeRuntime = new WakeRuntime(ledger);
	});

	pi.on("resources_discover", () => {
		if (activationTimer) clearTimeout(activationTimer);
		const generation = deliveryGeneration;
		activationTimer = setTimeout(() => {
			activationTimer = undefined;
			if (generation !== deliveryGeneration || !currentCtx || !registry || !ledger) return;
			deliveryActive = true;
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = setInterval(() => void deliverEvents(), 750);
			pollTimer.unref?.();
			void deliverEvents();
		}, 0);
		activationTimer.unref?.();
	});

	pi.on("message_start", (event) => {
		wakeRuntime?.messageStart(event.message);
	});

	pi.on("message_end", (event) => {
		wakeRuntime?.messageEnd(event.message);
	});

	pi.on("agent_settled" as any, (event: { aborted?: boolean }) => {
		if (!wakeRuntime) return;
		wakeRuntime.settled(event);
		void deliverEvents();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		deliveryGeneration += 1;
		deliveryActive = false;
		if (activationTimer) clearTimeout(activationTimer);
		activationTimer = undefined;
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		if (event.reason !== "reload" && registry) registry.stop("all");
		ctx.ui.setStatus("jobs", undefined);
		lastStatusText = undefined;
		wakeRuntime?.reset();
		currentCtx = undefined;
		registry = undefined;
		ledger = undefined;
		wakeRuntime = undefined;
	});

	pi.registerMessageRenderer("job-event", (message, { outputPad }, theme) => {
		const event = (message.details as { event?: { kind?: string; job?: Job; signal?: { level?: string } } } | undefined)?.event;
		const job = event?.job;
		const succeeded = event?.kind === "signal" ? event.signal?.level !== "error" : job?.status === "completed";
		const title = job ? event?.kind === "signal" ? `job notification: ${job.label} (${job.id})` : `job ${job.status}: ${job.label} (${job.id})` : "job event";
		const text = theme.fg("toolTitle", theme.bold(title))
			+ "\n" + theme.fg("toolOutput", String(message.content));
		const box = new Box(outputPad, 1, (line) => theme.bg(succeeded ? "toolSuccessBg" : "toolErrorBg", line));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.registerTool({
		name: "jobs",
		label: "Jobs",
		description: [
			"Run and manage session-scoped background jobs through launchd on macOS or systemd on Linux. Jobs survive /reload without restarting the command, and are stopped when the owning Pi session ends or is replaced.",
			"Use action=run for one execution, including long-running SQL, builds, or a user-defined watchdog loop. A command is never automatically submitted twice.",
			"Before returning, process readiness confirms both runner and command PIDs. For jobs that can fail silently after spawn, use readiness=signal and make the command touch $PI_JOB_READY only after external submission or its first successful health check.",
			"A long-running command may append one JSON object per line to $PI_JOB_EVENT to wake Pi without exiting; use it for sparse state transitions such as disconnected and recovered, not routine healthy samples.",
			"The default terminate_turn=true ends the current model turn only after readiness is confirmed. Running signals and terminal completion share a durable serialized at-least-once wake; duplicate reminders are preferable to a lost wake. Set false only when useful foreground work should continue independently.",
			"Use list/show/stop/retry/remove for management. retry is the only operation that deliberately creates another execution of a finished job.",
		].join(" "),
		promptSnippet: "Run one durable background command and wake this session at terminal completion",
		promptGuidelines: [
			"Use jobs run instead of agent-driven polling for long SQL, builds, and quiet watchdog loops.",
			"When ending the turn depends on proof beyond a spawned PID, set readiness=signal and make the command touch $PI_JOB_READY only after remote submission is accepted or the watchdog completes its first successful health check.",
			"For a self-recovering watchdog, append NDJSON state transitions to $PI_JOB_EVENT so it can wake Pi while remaining alive; suppress repeated healthy-state messages.",
			"After a successful terminating run call, do not poll jobs yourself; wait for durable running or terminal events to wake the session.",
		],
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
				const count = removeJobs(params.id);
				return { content: [{ type: "text", text: count ? `Removed ${count} finished job(s).` : `No finished job matched ${params.id}.` }], details: { action: "remove", count } };
			}
			if (params.action === "retry") {
				if (!params.id) throw new Error("id is required for action=retry");
				const job = await jobs.retry(params.id) as Job;
				return { content: [{ type: "text", text: `Started job ${job.id} as an explicit retry of ${params.id}.` }], details: { action: "retry", job } };
			}

			if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("jobs requires a long-lived Pi TUI or RPC session");
			if (!params.command.trim()) throw new Error("command must not be empty");
			const terminateTurn = params.terminate_turn !== false;
			let job: Job;
			try {
				job = await jobs.start({
					command: params.command.trim(),
					label: params.label,
					cwd: params.cwd?.trim() || ctx.cwd,
					timeoutMs: seconds(params.timeout_seconds, 86400),
					readiness: params.readiness,
					readyTimeoutMs: seconds(params.ready_timeout_seconds, 30),
					terminateTurn,
				}) as Job;
			} catch (error) {
				updateStatus();
				void deliverEvents();
				throw error;
			}
			const readyEvidence = job.readinessEvidence ?? (TERMINAL_STATUSES.has(job.status) ? "terminal" : job.readiness === "signal" ? "signal" : "process");
			updateStatus();
			const terminalNow = TERMINAL_STATUSES.has(job.status);
			if (terminalNow) ledger?.ack(job);
			return {
				content: [{ type: "text", text: terminalNow
					? `Job ${job.id} (${job.label}) finished during startup verification with status ${job.status}.\n\n${formatDetails(job)}`
					: `Started job ${job.id} (${job.label}); readiness=${readyEvidence} confirmed. It is owned by the OS service manager and will survive /reload without restarting the command.${terminateTurn ? " This turn will now stop; terminal completion has a durable at-least-once wake." : " This turn may continue while it runs."}` }],
				details: { action: "run", job },
				terminate: terminateTurn && !terminalNow,
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
			if (request.action === "list") return openJobsDashboard(jobs, removeJobs, ctx);
			if (request.action === "show") {
				const job = jobs.get(request.id) as Job | undefined;
				return ctx.ui.notify(job ? formatDetails(job) : `Job ${request.id} was not found.`, job ? "info" : "warning");
			}
			if (request.action === "stop") {
				const count = jobs.stop(request.id);
				return ctx.ui.notify(count ? `Requested stop for ${count} job(s).` : `No active job matched ${request.id}.`, count ? "info" : "warning");
			}
			if (request.action === "remove") {
				const count = removeJobs(request.id);
				return ctx.ui.notify(count ? `Removed ${count} finished job(s).` : `No finished job matched ${request.id}.`, count ? "info" : "warning");
			}
			try {
				const job = await jobs.retry(request.id) as Job;
				ctx.ui.notify(`Started ${job.id} as a retry of ${request.id}.`, "info");
			} catch (error) { ctx.ui.notify(String((error as Error)?.message ?? error), "error"); }
		},
	});
}
