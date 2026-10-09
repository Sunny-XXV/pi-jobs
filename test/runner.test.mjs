import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
		command: "true",
		cwd: root,
		timeoutMs: 2_000,
		terminateTurn: true,
		createdAt: Date.now(),
		...overrides,
	};
	const configPath = join(paths.directory, "config.json");
	atomicWriteJson(configPath, value);
	atomicWriteJson(paths.envPath, process.env);
	return { configPath, paths };
}

test("run executes exactly once even when the command fails", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-run-"));
	const countPath = join(root, "count");
	const { configPath, paths } = config(root, {
		command: `echo x >> ${JSON.stringify(countPath)}; exit 7`,
	});
	const state = await runJob(configPath);
	assert.equal(state.status, "failed");
	assert.equal(readFileSync(countPath, "utf8"), "x\n");
	assert.equal(existsSync(paths.envPath), false);
	assert.equal(JSON.parse(readFileSync(paths.statePath, "utf8")).status, "failed");
});

test("run times out without starting the command again", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-timeout-"));
	const countPath = join(root, "count");
	const { configPath } = config(root, {
		command: `echo x >> ${JSON.stringify(countPath)}; sleep 5`,
		timeoutMs: 50,
	});
	const state = await runJob(configPath);
	assert.equal(state.status, "timed_out");
	assert.equal(readFileSync(countPath, "utf8"), "x\n");
});

test("a second runner cannot execute an already-claimed job", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-claim-"));
	const countPath = join(root, "count");
	const configured = config(root, { command: `echo x >> ${JSON.stringify(countPath)}` });
	const first = await runJob(configured.configPath);
	const second = await runJob(configured.configPath);
	assert.equal(first.status, "completed");
	assert.equal(second.status, first.status);
	assert.equal(second.eventSeq, first.eventSeq);
	assert.equal(second.runnerPid, first.runnerPid);
	assert.equal(readFileSync(countPath, "utf8"), "x\n");
});

test("SIGTERM stops a long-running command and its process group", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-stop-"));
	const pidPath = join(root, "child.pid");
	const { configPath, paths } = config(root, {
		command: `echo $$ > ${JSON.stringify(pidPath)}; while :; do sleep 1; done`,
		timeoutMs: 10_000,
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
});
