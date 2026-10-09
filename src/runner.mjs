#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteJson, jobPaths, readJson, STATE_VERSION } from "./store.mjs";

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index < 0 || !process.argv[index + 1]) throw new Error("missing " + name);
	return process.argv[index + 1];
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
	let claim;
	try {
		claim = openSync(paths.claimPath, "wx", 0o600);
		writeFileSync(claim, JSON.stringify({ pid: process.pid, claimedAt: now() }) + "\n");
	} catch (error) {
		if (error && typeof error === "object" && error.code === "EEXIST") {
			const existing = readJson(paths.statePath, undefined);
			if (existing) return existing;
			throw new Error("execution was already claimed but no job state exists");
		}
		throw error;
	} finally {
		if (claim !== undefined) closeSync(claim);
	}

	let commandEnvironment = process.env;
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
		status: "queued",
		command: config.command,
		cwd: config.cwd,
		timeoutMs: config.timeoutMs,
		terminateTurn: config.terminateTurn !== false,
		ownerPid: config.ownerPid,
		createdAt: config.createdAt,
		startedAt: undefined,
		deadlineAt: config.createdAt + config.timeoutMs,
		finishedAt: undefined,
		runnerPid: process.pid,
		pid: undefined,
		exitCode: undefined,
		signal: undefined,
		error: undefined,
		eventSeq: 0,
	};
	const terminal = () => ["completed", "failed", "timed_out", "stopped"].includes(state.status);
	const save = () => atomicWriteJson(paths.statePath, state);
	const finish = (status, extra = {}) => {
		if (terminal()) return;
		Object.assign(state, extra);
		state.status = status;
		state.finishedAt = now();
		state.pid = undefined;
		state.eventSeq++;
		save();
	};
	const stop = () => {
		if (stopping || terminal()) return;
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

	const remaining = state.deadlineAt - now();
	if (remaining <= 0) {
		finish("timed_out");
	} else {
		state.status = "running";
		state.startedAt = now();
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
			finish("failed", { error: String(error?.message ?? error) });
		}

		if (child) {
			let timedOut = false;
			const timeoutTimer = setTimeout(() => {
				timedOut = true;
				signalChild(child, "SIGTERM");
				forceTimer = setTimeout(() => signalChild(child, "SIGKILL"), 750);
				forceTimer.unref?.();
			}, Math.max(1, remaining));
			timeoutTimer.unref?.();
			const result = await closeResult(child);
			clearTimeout(timeoutTimer);
			if (forceTimer) clearTimeout(forceTimer);
			forceTimer = undefined;
			currentChild = undefined;
			closeSync(stdoutFd);
			closeSync(stderrFd);
			const extra = { exitCode: result.code, signal: result.signal, error: result.error };
			if (stopping) finish("stopped", extra);
			else if (timedOut) finish("timed_out", extra);
			else finish(result.code === 0 ? "completed" : "failed", extra);
		}
	}

	if (stopping && !terminal()) finish("stopped");
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
