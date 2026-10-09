import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const STATE_VERSION = 1;
export const ACTIVE_STATUSES = new Set(["queued", "running", "waiting", "stopping"]);
export const TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out", "stopped"]);

export function sessionPaths(sessionId, root = join(homedir(), ".pi", "agent", "pi-jobs")) {
	if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("session id is required");
	const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
	const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 10);
	const directory = join(resolve(root), "sessions", safeId + "-" + hash);
	return { root: resolve(root), directory, jobsDirectory: join(directory, "jobs") };
}

export function jobPaths(sessionDirectory, id) {
	const directory = join(sessionDirectory, "jobs", id);
	return {
		directory,
		statePath: join(directory, "state.json"),
		controlPath: join(directory, "control.json"),
		claimPath: join(directory, "execution.claim"),
		envPath: join(directory, "env.json"),
		stdoutPath: join(directory, "stdout.log"),
		stderrPath: join(directory, "stderr.log"),
		runnerStdoutPath: join(directory, "runner.stdout.log"),
		runnerStderrPath: join(directory, "runner.stderr.log"),
		servicePath: join(directory, "service.plist"),
		releasedPath: join(directory, "service.released"),
	};
}

export function ensurePrivateDirectory(path) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	try { chmodSync(path, 0o700); } catch {}
}

export function atomicWriteJson(path, value) {
	ensurePrivateDirectory(dirname(path));
	const temporary = path + "." + process.pid + "." + randomUUID().slice(0, 6) + ".tmp";
	try {
		writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
		chmodSync(path, 0o600);
	} catch (error) {
		try { rmSync(temporary, { force: true }); } catch {}
		throw error;
	}
}

export function readJson(path, fallback) {
	try { return JSON.parse(readFileSync(path, "utf8")); }
	catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") return fallback;
		throw error;
	}
}

export function readTail(path, maxBytes = 24 * 1024) {
	let descriptor;
	try {
		descriptor = openSync(path, "r");
		const size = fstatSync(descriptor).size;
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		readSync(descriptor, buffer, 0, length, Math.max(0, size - length));
		return buffer.toString("utf8");
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") return "";
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

export function listJobIds(sessionDirectory) {
	try {
		return readdirSync(join(sessionDirectory, "jobs"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") return [];
		throw error;
	}
}

export function createJobId() {
	return randomUUID().slice(0, 8);
}
