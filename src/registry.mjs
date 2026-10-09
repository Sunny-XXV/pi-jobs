import { existsSync } from "node:fs";
import { jobPaths, listJobIds, readJson, readTail, TERMINAL_STATUSES } from "./store.mjs";

function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function normalizeState(id, config, state, paths) {
	const base = state ?? {
		version: 1,
		id,
		parentId: config?.parentId,
		label: config?.label ?? "job",
		mode: config?.mode ?? "run",
		status: "queued",
		command: config?.command ?? "",
		cwd: config?.cwd ?? "",
		intervalMs: config?.intervalMs,
		timeoutMs: config?.timeoutMs,
		checkTimeoutMs: config?.checkTimeoutMs,
		maxAttempts: config?.maxAttempts,
		terminateTurn: config?.terminateTurn !== false,
		ownerPid: config?.ownerPid,
		attempts: 0,
		createdAt: config?.createdAt ?? Date.now(),
		deadlineAt: (config?.createdAt ?? Date.now()) + (config?.timeoutMs ?? 0),
		eventSeq: 0,
	};
	if (["queued", "running", "waiting", "stopping"].includes(base.status) && base.runnerPid && !alive(base.runnerPid)) {
		base.status = "failed";
		base.finishedAt ??= Date.now();
		base.error ??= "job runner exited without recording a terminal state";
		base.eventSeq = Math.max(1, base.eventSeq ?? 0);
	}
	return {
		...base,
		lastStdout: readTail(paths.stdoutPath),
		lastStderr: readTail(paths.stderrPath),
		runnerStderr: readTail(paths.runnerStderrPath, 6 * 1024),
	};
}

export class JobRegistry {
	constructor({ sessionDirectory, serviceManager }) {
		this.sessionDirectory = sessionDirectory;
		this.serviceManager = serviceManager;
	}

	list() {
		const jobs = listJobIds(this.sessionDirectory)
			.map((id) => this.get(id))
			.filter(Boolean)
			.sort((a, b) => b.createdAt - a.createdAt);
		for (const job of jobs) {
			if (TERMINAL_STATUSES.has(job.status)) this.serviceManager.release(job.id);
		}
		return jobs;
	}

	get(id) {
		const paths = jobPaths(this.sessionDirectory, id);
		const config = readJson(paths.directory + "/config.json", undefined);
		if (!config && !existsSync(paths.statePath)) return undefined;
		return normalizeState(id, config, readJson(paths.statePath, undefined), paths);
	}

	start(spec, parentId) {
		const id = this.serviceManager.start(spec, parentId);
		return this.get(id) ?? { id, label: spec.label ?? "job", mode: spec.mode, status: "queued", createdAt: Date.now(), command: spec.command, cwd: spec.cwd, attempts: 0, eventSeq: 0 };
	}

	stop(id) {
		if (id === "all") {
			let count = 0;
			for (const job of this.list()) {
				if (TERMINAL_STATUSES.has(job.status)) continue;
				if (this.serviceManager.stop(job.id)) count++;
			}
			return count;
		}
		const job = this.get(id);
		if (!job || TERMINAL_STATUSES.has(job.status)) return 0;
		return Number(this.serviceManager.stop(id));
	}

	remove(id) {
		if (id === "finished") {
			let count = 0;
			for (const job of this.list()) {
				if (!TERMINAL_STATUSES.has(job.status)) continue;
				if (this.serviceManager.remove(job.id)) count++;
			}
			return count;
		}
		const job = this.get(id);
		if (!job || !TERMINAL_STATUSES.has(job.status)) return 0;
		return Number(this.serviceManager.remove(id));
	}

	retry(id) {
		const job = this.get(id);
		if (!job) throw new Error("job " + id + " was not found");
		if (!TERMINAL_STATUSES.has(job.status)) throw new Error("job " + id + " is still active");
		return this.start({
			mode: job.mode,
			command: job.command,
			label: job.label,
			cwd: job.cwd,
			intervalMs: job.intervalMs,
			timeoutMs: job.timeoutMs,
			checkTimeoutMs: job.checkTimeoutMs,
			maxAttempts: job.maxAttempts,
			terminateTurn: job.terminateTurn,
		}, id);
	}
}
