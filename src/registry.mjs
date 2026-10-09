import { existsSync } from "node:fs";
import { jobPaths, listJobIds, readJobSignals, readJson, readTail, TERMINAL_STATUSES } from "./store.mjs";

function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function normalizeState(id, config, state, paths) {
	const base = state ?? {
		version: 1,
		id,
		parentId: config?.parentId,
		label: config?.label ?? "job",
		status: "queued",
		command: config?.command ?? "",
		cwd: config?.cwd ?? "",
		timeoutMs: config?.timeoutMs,
		readiness: config?.readiness ?? "process",
		readyTimeoutMs: config?.readyTimeoutMs,
		terminateTurn: config?.terminateTurn !== false,
		ownerPid: config?.ownerPid,
		createdAt: config?.createdAt ?? Date.now(),
		deadlineAt: (config?.createdAt ?? Date.now()) + (config?.timeoutMs ?? 0),
		eventSeq: 0,
	};
	if (["queued", "running", "stopping"].includes(base.status) && base.runnerPid && !alive(base.runnerPid)) {
		base.status = "failed";
		base.finishedAt ??= Date.now();
		base.error ??= "job runner exited without recording a terminal state";
		base.eventSeq = Math.max(1, base.eventSeq ?? 0);
	}
	return {
		...base,
		events: readJobSignals(paths.eventsPath),
		lastStdout: readTail(paths.stdoutPath),
		lastStderr: readTail(paths.stderrPath),
		runnerStderr: readTail(paths.runnerStderrPath, 6 * 1024),
	};
}

export class JobRegistry {
	constructor({ sessionDirectory, serviceManager, startupAckTimeoutMs = 10_000, startupPollMs = 25 }) {
		this.sessionDirectory = sessionDirectory;
		this.serviceManager = serviceManager;
		this.startupAckTimeoutMs = startupAckTimeoutMs;
		this.startupPollMs = startupPollMs;
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

	async start(spec, parentId) {
		const id = this.serviceManager.start(spec, parentId);
		const acknowledgementTimeoutMs = Math.min(this.startupAckTimeoutMs, Math.max(1, Number(spec.timeoutMs) || this.startupAckTimeoutMs));
		const deadline = Date.now() + acknowledgementTimeoutMs;
		let job;
		while (Date.now() < deadline) {
			job = this.get(id);
			if (job && (TERMINAL_STATUSES.has(job.status) || (job.status === "running" && job.runnerPid && job.pid))) break;
			await sleep(this.startupPollMs);
		}
		job = this.get(id) ?? job;
		if (!job || (!TERMINAL_STATUSES.has(job.status) && !(job.status === "running" && job.runnerPid && job.pid))) {
			const stopped = this.serviceManager.stop(id);
			const error = new Error(`job ${id} did not acknowledge runner startup within ${acknowledgementTimeoutMs}ms${stopped ? " and was stopped" : "; automatic stop failed, inspect it with jobs show " + id}`);
			error.jobId = id;
			throw error;
		}
		let readinessEvidence = "process";
		try {
			if (spec.readiness === "signal") {
				const readiness = await this.waitForReady(id, { timeoutMs: spec.readyTimeoutMs });
				job = readiness.job;
				readinessEvidence = readiness.evidence;
			} else if (TERMINAL_STATUSES.has(job.status)) {
				readinessEvidence = "terminal";
			}
		} catch (error) {
			error.jobId = id;
			throw error;
		}
		job = this.get(id) ?? job;
		return { ...job, readinessEvidence };
	}

	async waitForReady(id, options = {}) {
		const timeoutMs = Math.max(1, Number(options.timeoutMs) || 30_000);
		const readyFile = jobPaths(this.sessionDirectory, id).readyPath;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const job = this.get(id);
			if (!job) throw new Error("job " + id + " disappeared before readiness was confirmed");
			if (existsSync(readyFile)) return { job, ready: true, evidence: "signal" };
			if (TERMINAL_STATUSES.has(job.status)) {
				if (job.status === "completed") return { job, ready: true, evidence: "terminal" };
				throw new Error(`job ${id} ${job.status} before readiness was confirmed${job.error ? ": " + job.error : ""}`);
			}
			await sleep(this.startupPollMs);
		}
		const finalJob = this.get(id);
		if (!finalJob) throw new Error("job " + id + " disappeared before readiness was confirmed");
		if (existsSync(readyFile)) return { job: finalJob, ready: true, evidence: "signal" };
		if (TERMINAL_STATUSES.has(finalJob.status)) {
			if (finalJob.status === "completed") return { job: finalJob, ready: true, evidence: "terminal" };
			throw new Error(`job ${id} ${finalJob.status} before readiness was confirmed${finalJob.error ? ": " + finalJob.error : ""}`);
		}
		const stopped = this.serviceManager.stop(id);
		throw new Error(`job ${id} did not produce readiness evidence within ${timeoutMs}ms${stopped ? " and was stopped" : "; automatic stop failed, inspect it with jobs show " + id}`);
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

	async retry(id) {
		const job = this.get(id);
		if (!job) throw new Error("job " + id + " was not found");
		if (!TERMINAL_STATUSES.has(job.status)) throw new Error("job " + id + " is still active");
		return this.start({
			command: job.command,
			label: job.label,
			cwd: job.cwd,
			timeoutMs: job.timeoutMs,
			readiness: job.readiness,
			readyTimeoutMs: job.readyTimeoutMs,
			terminateTurn: job.terminateTurn,
		}, id);
	}
}
