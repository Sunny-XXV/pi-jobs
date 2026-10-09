import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runJob } from "../src/runner.mjs";
import { atomicWriteJson, ensurePrivateDirectory, jobPaths } from "../src/store.mjs";

function config(root, overrides = {}) {
	const id = overrides.id ?? "test-job";
	const paths = jobPaths(root, id);
	ensurePrivateDirectory(paths.directory);
	const value = {
		version: 1,
		id,
		sessionDirectory: root,
		label: "test",
		mode: "run",
		command: "true",
		cwd: root,
		intervalMs: 5,
		timeoutMs: 2_000,
		checkTimeoutMs: 1_000,
		maxAttempts: 1,
		terminateTurn: true,
		createdAt: Date.now(),
		env: process.env,
		...overrides,
	};
	const configPath = join(paths.directory, "config.json");
	atomicWriteJson(configPath, value);
	return { configPath, paths };
}

test("run executes exactly once even when the command fails", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-run-"));
	const countPath = join(root, "count");
	const { configPath, paths } = config(root, {
		command: `echo x >> ${JSON.stringify(countPath)}; exit 7`,
		mode: "run",
		maxAttempts: 99,
	});
	const state = await runJob(configPath);
	assert.equal(state.status, "failed");
	assert.equal(state.attempts, 1);
	assert.equal(readFileSync(countPath, "utf8"), "x\n");
	assert.equal(JSON.parse(readFileSync(paths.statePath, "utf8")).status, "failed");
});

test("watch retries a failing predicate until it succeeds", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-watch-"));
	const countPath = join(root, "count");
	writeFileSync(countPath, "0\n");
	const command = `n=$(cat ${JSON.stringify(countPath)}); n=$((n+1)); echo "$n" > ${JSON.stringify(countPath)}; test "$n" -ge 3`;
	const { configPath } = config(root, { command, mode: "watch", maxAttempts: 5, intervalMs: 5 });
	const state = await runJob(configPath);
	assert.equal(state.status, "completed");
	assert.equal(state.attempts, 3);
	assert.equal(readFileSync(countPath, "utf8"), "3\n");
});

test("SIGTERM stops a long-running command and its process group", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-stop-"));
	const pidPath = join(root, "child.pid");
	const { configPath, paths } = config(root, {
		command: `echo $$ > ${JSON.stringify(pidPath)}; while :; do sleep 1; done`,
		timeoutMs: 10_000,
		checkTimeoutMs: 10_000,
	});
	const running = runJob(configPath);
	while (true) {
		try {
			const state = JSON.parse(readFileSync(paths.statePath, "utf8"));
			if (state.pid) break;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	process.emit("SIGTERM");
	const state = await running;
	assert.equal(state.status, "stopped");
	assert.equal(state.attempts, 1);
});
