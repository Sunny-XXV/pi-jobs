import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobRegistry } from "../src/registry.mjs";
import { ServiceManager } from "../src/service-manager.mjs";
import { ensurePrivateDirectory, sessionPaths } from "../src/store.mjs";

async function waitFor(read, predicate, timeoutMs = 8_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	while (Date.now() < deadline) {
		try { value = read(); } catch {}
		if (value && predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("condition timed out; last value: " + JSON.stringify(value));
}

function createRegistry(root, sessionId) {
	const paths = sessionPaths(sessionId, root);
	ensurePrivateDirectory(paths.jobsDirectory);
	const serviceManager = new ServiceManager({ sessionId, sessionDirectory: paths.directory });
	return new JobRegistry({ sessionDirectory: paths.directory, serviceManager });
}

const integration = process.platform === "darwin" && process.env.PI_JOBS_SKIP_SERVICE_TESTS !== "1" ? test : test.skip;

integration("launchd service labels do not collide for sessions with the same visible prefix", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-launchd-label-"));
	const prefix = "session-prefix-that-is-longer-than-the-old-truncation-boundary-";
	const first = createRegistry(root, prefix + "a");
	const second = createRegistry(root, prefix + "b");
	const a = await first.start({ command: "sleep 2", cwd: root, timeoutMs: 10_000 });
	const b = await second.start({ command: "sleep 2", cwd: root, timeoutMs: 10_000 });
	t.after(() => {
		for (const [registry, job] of [[first, a], [second, b]]) {
			try { registry.stop(job.id); } catch {}
			try { registry.remove(job.id); } catch {}
		}
	});
	const aConfig = JSON.parse(readFileSync(join(sessionPaths(prefix + "a", root).jobsDirectory, a.id, "config.json"), "utf8"));
	const bConfig = JSON.parse(readFileSync(join(sessionPaths(prefix + "b", root).jobsDirectory, b.id, "config.json"), "utf8"));
	assert.notEqual(aConfig.serviceName.split(".").slice(0, -1).join("."), bConfig.serviceName.split(".").slice(0, -1).join("."));
	assert.equal(a.status, "running");
	assert.equal(b.status, "running");
});

integration("launchd job survives client recreation without duplicate submission", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-launchd-"));
	const sessionId = "integration-" + Date.now();
	const countPath = join(root, "submissions");
	let registry = createRegistry(root, sessionId);
	const started = await registry.start({
		label: "long sql simulation",
		command: `echo submit >> ${JSON.stringify(countPath)}; sleep 2; echo done`,
		cwd: root,
		timeoutMs: 10_000,
		terminateTurn: true,
	});
	t.after(() => {
		try { registry.stop(started.id); } catch {}
		try { registry.remove(started.id); } catch {}
	});
	const running = await waitFor(
		() => registry.get(started.id),
		(job) => job.status === "running" && job.pid && job.runnerPid && existsSync(countPath) && readFileSync(countPath, "utf8") === "submit\n",
	);
	const originalRunnerPid = running.runnerPid;
	const originalCommandPid = running.pid;
	assert.equal(readFileSync(countPath, "utf8"), "submit\n");

	registry = createRegistry(root, sessionId);
	const reattached = registry.get(started.id);
	assert.equal(reattached.runnerPid, originalRunnerPid);
	assert.equal(reattached.pid, originalCommandPid);
	assert.equal(readFileSync(countPath, "utf8"), "submit\n");

	const completed = await waitFor(() => registry.get(started.id), (job) => job.status === "completed");
	assert.equal(readFileSync(countPath, "utf8"), "submit\n");
	assert.match(completed.lastStdout, /done/);
});

integration("launchd signal readiness proves the command reached its checkpoint", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-launchd-ready-"));
	const sessionId = "integration-ready-" + Date.now();
	const registry = createRegistry(root, sessionId);
	const started = await registry.start({
		label: "ready test",
		command: 'touch "$PI_JOB_READY"; sleep 2',
		cwd: root,
		timeoutMs: 10_000,
		readiness: "signal",
		readyTimeoutMs: 2_000,
		terminateTurn: true,
	});
	t.after(() => {
		try { registry.stop(started.id); } catch {}
		try { registry.remove(started.id); } catch {}
	});
	assert.equal(started.readinessEvidence, "signal");
	assert.equal(started.status, "running");
});

integration("launchd stop terminates an active job", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-launchd-stop-"));
	const sessionId = "integration-stop-" + Date.now();
	const registry = createRegistry(root, sessionId);
	const started = await registry.start({
		label: "stop test",
		command: "while :; do sleep 1; done",
		cwd: root,
		timeoutMs: 30_000,
		terminateTurn: true,
	});
	t.after(() => {
		try { registry.stop(started.id); } catch {}
		try { registry.remove(started.id); } catch {}
	});
	await waitFor(() => registry.get(started.id), (job) => job.status === "running" && job.pid);
	assert.equal(registry.stop(started.id), 1);
	await waitFor(() => registry.get(started.id), (job) => job.status === "stopped");
});
