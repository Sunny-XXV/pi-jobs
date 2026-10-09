import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobRegistry } from "../src/registry.mjs";
import { atomicWriteJson, ensurePrivateDirectory, jobPaths } from "../src/store.mjs";

function harness() {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-registry-"));
	const id = "job-1";
	const paths = jobPaths(root, id);
	ensurePrivateDirectory(paths.directory);
	const base = {
		version: 1,
		id,
		label: "test",
		status: "queued",
		command: "sleep 60",
		cwd: root,
		timeoutMs: 60_000,
		createdAt: Date.now(),
		deadlineAt: Date.now() + 60_000,
		eventSeq: 0,
	};
	atomicWriteJson(join(paths.directory, "config.json"), { ...base, sessionDirectory: root });
	atomicWriteJson(paths.statePath, base);
	const calls = { stop: 0 };
	const serviceManager = {
		start: (spec) => {
			atomicWriteJson(paths.statePath, { ...base, readiness: spec.readiness ?? "process", readyTimeoutMs: spec.readyTimeoutMs });
			return id;
		},
		stop: () => { calls.stop++; return true; },
		release: () => true,
	};
	const registry = new JobRegistry({ sessionDirectory: root, serviceManager, startupAckTimeoutMs: 40, startupPollMs: 5 });
	return { registry, paths, calls };
}

test("startup acknowledgement requires runner and command process evidence", async () => {
	const { registry, paths } = harness();
	setTimeout(() => atomicWriteJson(paths.statePath, {
		...JSON.parse(readFileSync(paths.statePath, "utf8")),
		status: "running",
		runnerPid: process.pid,
		pid: process.pid,
	}), 5);
	const job = await registry.start({ command: "sleep 60", cwd: process.cwd() });
	assert.equal(job.status, "running");
	assert.equal(job.pid, process.pid);
	assert.equal(job.readinessEvidence, "process");
});

test("missing startup acknowledgement stops the service and rejects", async () => {
	const { registry, calls } = harness();
	await assert.rejects(() => registry.start({ command: "sleep 60", cwd: process.cwd() }), /within 40ms and was stopped/);
	assert.equal(calls.stop, 1);
});

test("startup acknowledgement is bounded by the shorter overall timeout", async () => {
	const { registry, calls } = harness();
	await assert.rejects(() => registry.start({ command: "sleep 60", cwd: process.cwd(), timeoutMs: 7 }), /within 7ms and was stopped/);
	assert.equal(calls.stop, 1);
});

test("signal readiness arms completion wake only after the private marker", async () => {
	const { registry, paths } = harness();
	setTimeout(() => atomicWriteJson(paths.statePath, {
		...JSON.parse(readFileSync(paths.statePath, "utf8")),
		status: "running",
		runnerPid: process.pid,
		pid: process.pid,
	}), 5);
	setTimeout(() => writeFileSync(paths.readyPath, "ready\n"), 10);
	const job = await registry.start({ command: "sleep 60", cwd: process.cwd(), readiness: "signal", readyTimeoutMs: 40 });
	assert.equal(job.readinessEvidence, "signal");
});

test("successful completion before signal readiness returns terminal evidence", async () => {
	const { registry, paths } = harness();
	setTimeout(() => atomicWriteJson(paths.statePath, {
		...JSON.parse(readFileSync(paths.statePath, "utf8")),
		status: "completed",
		finishedAt: Date.now(),
		eventSeq: 1,
	}), 5);
	const job = await registry.start({ command: "true", cwd: process.cwd(), readiness: "signal", readyTimeoutMs: 40 });
	assert.equal(job.status, "completed");
	assert.equal(job.readinessEvidence, "terminal");
});

test("missing signal readiness stops the service and rejects", async () => {
	const { registry, paths, calls } = harness();
	setTimeout(() => atomicWriteJson(paths.statePath, {
		...JSON.parse(readFileSync(paths.statePath, "utf8")),
		status: "running",
		runnerPid: process.pid,
		pid: process.pid,
	}), 5);
	let error;
	try {
		await registry.start({ command: "sleep 60", cwd: process.cwd(), readiness: "signal", readyTimeoutMs: 25 });
	} catch (value) { error = value; }
	assert.match(String(error?.message), /did not produce readiness evidence/);
	assert.equal(error?.jobId, "job-1");
	assert.equal(calls.stop, 1);
});

test("failure before signal readiness is rejected", async () => {
	const { registry, paths } = harness();
	setTimeout(() => atomicWriteJson(paths.statePath, {
		...JSON.parse(readFileSync(paths.statePath, "utf8")),
		status: "failed",
		finishedAt: Date.now(),
		eventSeq: 1,
	}), 5);
	let error;
	try {
		await registry.start({ command: "false", cwd: process.cwd(), readiness: "signal", readyTimeoutMs: 40 });
	} catch (value) { error = value; }
	assert.match(String(error?.message), /failed before readiness/);
	assert.equal(error?.jobId, "job-1");
});
