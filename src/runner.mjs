#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteJson, jobPaths, STATE_VERSION } from "./store.mjs";

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index < 0 || !process.argv[index + 1]) throw new Error("missing " + name);
	return process.argv[index + 1];
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)));
}

function signalChild(child, signal) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		try { child.kill(signal); } catch {}
	}
}

function closeResult(child) {
	return new Promise((resolveClose) => {
		let error;
		child.once("error", (value) => { error = String(value?.message ?? value); });
		child.once("close", (code, signal) => resolveClose({ code, signal: signal ?? undefined, error }));
	});
}

export async function runJob(configPath, options = {}) {
	const now = options.now ?? (() => Date.now());
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	const paths = jobPaths(config.sessionDirectory, config.id);
	let commandEnvironment = config.env || process.env;
	try {
		commandEnvironment = JSON.parse(readFileSync(paths.envPath, "utf8"));
		rmSync(paths.envPath, { force: true });
	} catch (error) {
		if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
	}
	let currentChild;
	let stopping = false;
	let forceTimer;
	const state = {
		version: STATE_VERSION,
		id: config.id,
		parentId: config.parentId,
		label: config.label,
		mode: config.mode,
		status: "queued",
		command: config.command,
		cwd: config.cwd,
		intervalMs: config.intervalMs,
		timeoutMs: config.timeoutMs,
		checkTimeoutMs: config.checkTimeoutMs,
		maxAttempts: config.maxAttempts,
		terminateTurn: config.terminateTurn !== false,
		ownerPid: config.ownerPid,
		attempts: 0,
		createdAt: config.createdAt,
		startedAt: undefined,
		deadlineAt: config.createdAt + config.timeoutMs,
		finishedAt: undefined,
		nextAttemptAt: undefined,
		runnerPid: process.pid,
		pid: undefined,
		lastCode: undefined,
		lastSignal: undefined,
		error: undefined,
		eventSeq: 0,
	};
	const isTerminal = () => ["completed", "failed", "timed_out", "stopped"].includes(state.status);
	const save = () => atomicWriteJson(paths.statePath, state);
	const finish = (status, extra = {}) => {
		if (["completed", "failed", "timed_out", "stopped"].includes(state.status)) return;
		Object.assign(state, extra);
		state.status = status;
		state.finishedAt = now();
		state.nextAttemptAt = undefined;
		state.pid = undefined;
		state.eventSeq++;
		save();
	};
	const stop = () => {
		if (stopping || isTerminal()) return;
		stopping = true;
		state.status = "stopping";
		save();
		signalChild(currentChild, "SIGTERM");
		forceTimer = setTimeout(() => signalChild(currentChild, "SIGKILL"), 750);
		forceTimer.unref?.();
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	const ownerWatch = config.ownerPid ? setInterval(() => {
		try { process.kill(config.ownerPid, 0); }
		catch { stop(); }
	}, 1_000) : undefined;
	ownerWatch?.unref?.();
	save();

	while (!stopping) {
		const remaining = state.deadlineAt - now();
		if (remaining <= 0 || state.attempts >= state.maxAttempts) {
			finish("timed_out");
			break;
		}
		state.status = "running";
		state.attempts++;
		state.startedAt ??= now();
		state.nextAttemptAt = undefined;
		state.lastCode = undefined;
		state.lastSignal = undefined;
		state.error = undefined;
		save();

		const stdoutFd = openSync(paths.stdoutPath, "w", 0o600);
		const stderrFd = openSync(paths.stderrPath, "w", 0o600);
		let child;
		try {
			child = spawn(config.shell || process.env.PI_JOBS_SHELL || "/bin/bash", ["-c", state.command], {
				cwd: state.cwd,
				env: commandEnvironment,
				stdio: ["ignore", stdoutFd, stderrFd],
				detached: process.platform !== "win32",
			});
			currentChild = child;
			state.pid = child.pid;
			save();
		} catch (error) {
			closeSync(stdoutFd);
			closeSync(stderrFd);
			state.error = String(error?.message ?? error);
			if (state.mode === "run") {
				finish("failed");
				break;
			}
			continue;
		}

		let attemptTimedOut = false;
		const timer = setTimeout(() => {
			attemptTimedOut = true;
			signalChild(child, "SIGTERM");
			forceTimer = setTimeout(() => signalChild(child, "SIGKILL"), 750);
			forceTimer.unref?.();
		}, Math.max(1, Math.min(state.checkTimeoutMs, remaining)));
		timer.unref?.();
		const result = await closeResult(child);
		clearTimeout(timer);
		if (forceTimer) clearTimeout(forceTimer);
		forceTimer = undefined;
		currentChild = undefined;
		state.pid = undefined;
		state.lastCode = result.code;
		state.lastSignal = result.signal;
		state.error = result.error;
		closeSync(stdoutFd);
		closeSync(stderrFd);

		if (stopping) {
			finish("stopped");
			break;
		}
		if (!attemptTimedOut && result.code === 0) {
			finish("completed");
			break;
		}
		if (state.mode === "run") {
			finish(attemptTimedOut ? "timed_out" : "failed");
			break;
		}
		if (now() >= state.deadlineAt || state.attempts >= state.maxAttempts) {
			finish("timed_out");
			break;
		}
		state.status = "waiting";
		state.nextAttemptAt = Math.min(state.deadlineAt, now() + state.intervalMs);
		save();
		while (!stopping && now() < state.nextAttemptAt) await sleep(Math.min(200, state.nextAttemptAt - now()));
	}

	if (stopping && !["completed", "failed", "timed_out", "stopped"].includes(state.status)) finish("stopped");
	if (forceTimer) clearTimeout(forceTimer);
	if (ownerWatch) clearInterval(ownerWatch);
	process.off("SIGTERM", stop);
	process.off("SIGINT", stop);
	return state;
}

async function main() {
	process.umask(0o077);
	const configPath = resolve(argument("--config"));
	await runJob(configPath);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	main().catch((error) => {
		console.error("pi-job-runner:", error);
		process.exitCode = 1;
	});
}
