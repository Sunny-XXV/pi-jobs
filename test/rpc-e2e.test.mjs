import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TEST_DIR, "..");
const PI = process.env.PI_BIN || spawnSync("/usr/bin/env", ["sh", "-c", "command -v pi"], { encoding: "utf8" }).stdout.trim();
const enabled = process.platform === "darwin" && Boolean(PI) && existsSync(PI) && process.env.PI_JOBS_SKIP_RPC_E2E !== "1" ? test : test.skip;

function sessionDirectory(sessionId) {
	const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
	const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 10);
	return join(homedir(), ".pi", "agent", "pi-jobs", "sessions", `${safeId}-${hash}`);
}

function waitFor(predicate, timeoutMs = 20_000) {
	return new Promise((resolveWait, reject) => {
		const deadline = Date.now() + timeoutMs;
		const timer = setInterval(() => {
			try {
				const value = predicate();
				if (value) {
					clearInterval(timer);
					resolveWait(value);
				} else if (Date.now() >= deadline) {
					clearInterval(timer);
					reject(new Error("condition timed out"));
				}
			} catch (error) {
				clearInterval(timer);
				reject(error);
			}
		}, 25);
	});
}

enabled("Pi RPC terminates after readiness, wakes once on completion, and durably acknowledges", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-rpc-e2e-"));
	const sessionId = "pi-jobs-rpc-e2e-" + Date.now();
	const child = spawn(PI, [
		"--mode", "rpc",
		"--session-id", sessionId,
		"--session-dir", join(root, "sessions"),
		"--offline",
		"--no-extensions",
		"-e", join(TEST_DIR, "rpc-e2e-provider.ts"),
		"-e", join(ROOT, "index.ts"),
		"--provider", "pi-jobs-e2e",
		"--model", "tool-driver",
	], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let buffer = "";
	const events = [];
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		buffer += chunk;
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line) events.push(JSON.parse(line));
		}
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	t.after(async () => {
		if (child.exitCode === null) {
			child.stdin.end();
			await Promise.race([
				new Promise((resolveExit) => child.once("exit", resolveExit)),
				new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
			]);
		}
		if (child.exitCode === null) child.kill("SIGKILL");
		rmSync(sessionDirectory(sessionId), { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});

	child.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: "run the test job" }) + "\n");
	await waitFor(() => events.filter((event) => event.type === "agent_settled").length >= 2);

	const toolEnd = events.find((event) => event.type === "tool_execution_end" && event.toolName === "jobs");
	assert.equal(toolEnd?.result?.terminate, true, stdout);
	assert.equal(toolEnd?.result?.details?.job?.readinessEvidence, "process", stdout);
	const jobEvents = events.filter((event) => event.type === "message_start" && event.message?.customType === "job-event");
	assert.equal(jobEvents.length, 1, stdout);
	assert.equal(jobEvents[0].message.details.status, "completed");
	assert.equal(events.filter((event) => event.type === "extension_error").length, 0, stderr);

	const ledgerPath = join(sessionDirectory(sessionId), "notifications.json");
	await waitFor(() => existsSync(ledgerPath));
	const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
	assert.equal(ledger[jobEvents[0].message.details.id], 1);

	await new Promise((resolveWait) => setTimeout(resolveWait, 1_200));
	assert.equal(events.filter((event) => event.type === "message_start" && event.message?.customType === "job-event").length, 1, stdout);
});
