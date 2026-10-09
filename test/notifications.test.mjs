import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NotificationLedger } from "../src/notifications.mjs";
import { jobPaths, readJobSignals } from "../src/store.mjs";

function job(id = "job-1", overrides = {}) {
	return { id, label: id, status: "completed", createdAt: 1, finishedAt: 2, eventSeq: 1, events: [], ...overrides };
}

function terminal(id = "job-1", sequence = 1) {
	const value = job(id, { eventSeq: sequence });
	return { key: `${id}:terminal:${sequence}`, kind: "terminal", id, sequence, job: value };
}

function signal(id = "job-1", sequence = 1, emittedAt = sequence) {
	const value = job(id, { status: "running", finishedAt: undefined, eventSeq: 0, events: [{ sequence, type: "test", level: "warning", message: `signal ${sequence}`, emittedAt }] });
	return { key: `${id}:signal:${sequence}`, kind: "signal", id, sequence, job: value, signal: value.events[0] };
}

test("only one wake event is active at a time", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-next-"));
	const ledger = new NotificationLedger(root);
	const first = job("first");
	const second = job("second");
	assert.equal(ledger.next([first, second]).id, "first");
	const firstEvent = ledger.next([first, second]);
	ledger.sent(firstEvent);
	assert.equal(ledger.next([first, second]), undefined);
	assert.equal(ledger.started(firstEvent), true);
	assert.equal(ledger.confirmStarted(), true);
	assert.equal(ledger.next([first, second]).id, "second");
});

test("terminal wake stays pending until its triggered run starts and completes", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-"));
	const ledger = new NotificationLedger(root);
	const value = job();
	const event = terminal();
	assert.deepEqual(ledger.pending([value]), [event]);
	ledger.sent(event);
	assert.deepEqual(ledger.pending([value]), []);
	assert.equal(ledger.started(event), true);
	assert.equal(ledger.confirmStarted(), true);
	assert.deepEqual(ledger.pending([value]), []);
	assert.deepEqual(new NotificationLedger(root).pending([value]), []);
});

test("running signals are serialized before the later terminal event", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-signals-"));
	const value = job("watch", {
		events: [
			{ sequence: 1, type: "disconnected", level: "error", message: "offline", emittedAt: 10 },
			{ sequence: 2, type: "recovered", level: "info", message: "online", emittedAt: 20 },
		],
		finishedAt: 30,
	});
	const ledger = new NotificationLedger(root);
	const first = ledger.next([value]);
	assert.equal(first.key, "watch:signal:1");
	ledger.ack(first);
	const second = ledger.next([value]);
	assert.equal(second.key, "watch:signal:2");
	ledger.ack(second);
	assert.equal(ledger.next([value]).key, "watch:terminal:1");
});

test("per-job signal sequence is preserved even when emittedAt clocks move backward", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-clock-"));
	const value = job("watch", {
		status: "running", finishedAt: undefined, eventSeq: 0,
		events: [
			{ sequence: 1, type: "down", level: "error", message: "offline", emittedAt: 200 },
			{ sequence: 2, type: "up", level: "info", message: "online", emittedAt: 100 },
		],
	});
	const ledger = new NotificationLedger(root);
	assert.equal(ledger.next([value]).key, "watch:signal:1");
	ledger.ack(ledger.next([value]));
	assert.equal(ledger.next([value]).key, "watch:signal:2");
});

test("running signals survive extension-runtime recreation and resume after the acknowledged sequence", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-reload-"));
	const firstView = job("watch", {
		status: "running", finishedAt: undefined, eventSeq: 0,
		events: [{ sequence: 1, type: "down", level: "error", message: "offline", emittedAt: 10 }],
	});
	const firstRuntime = new NotificationLedger(root);
	const first = firstRuntime.next([firstView]);
	firstRuntime.ack(first);
	const secondView = { ...firstView, events: [...firstView.events, { sequence: 2, type: "up", level: "info", message: "online", emittedAt: 20 }] };
	const replacementRuntime = new NotificationLedger(root);
	assert.equal(replacementRuntime.next([secondView]).key, "watch:signal:2");
	replacementRuntime.ack(replacementRuntime.next([secondView]));
	assert.deepEqual(new NotificationLedger(root).pending([secondView]), []);
});

test("an unconfirmed wake is redelivered instead of silently acknowledged", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-redeliver-"));
	let now = 1_000;
	const ledger = new NotificationLedger(root, { now: () => now, retryAfterMs: 100 });
	const value = job();
	const event = terminal();
	ledger.sent(event);
	assert.equal(ledger.hasInflight(), true);
	assert.deepEqual(ledger.pending([value], { retryUnstarted: true }), []);
	now += 101;
	assert.deepEqual(ledger.pending([value], { retryUnstarted: true }), [event]);
	assert.deepEqual(new NotificationLedger(root).pending([value]), [event]);
});

test("acknowledgments from multiple runtimes merge without losing event kinds", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-merge-"));
	const firstLedger = new NotificationLedger(root);
	const secondLedger = new NotificationLedger(root);
	const first = signal("shared", 1);
	const second = terminal("other", 1);
	assert.equal(firstLedger.ack(first), true);
	assert.equal(secondLedger.ack(second), true);
	const values = [first.job, second.job];
	assert.deepEqual(new NotificationLedger(root).pending(values), []);
});

test("legacy numeric terminal acknowledgments remain readable", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-legacy-"));
	const ledger = new NotificationLedger(root);
	assert.equal(ledger.ack(terminal("legacy", 1)), true);
	// A numeric value is the pre-signal schema and must still acknowledge terminal events.
	writeFileSync(join(root, "notifications.json"), '{"legacy":1}\n');
	assert.deepEqual(new NotificationLedger(root).pending([job("legacy")]), []);
});

test("prune removes only ledger entries for jobs no longer retained", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-prune-"));
	const ledger = new NotificationLedger(root);
	ledger.ack(terminal("removed"));
	ledger.ack(terminal("retained"));
	ledger.sent(signal("inflight"));
	assert.equal(ledger.prune([job("retained")]), true);
	assert.deepEqual(new NotificationLedger(root).pending([job("removed"), job("retained")]).map((event) => event.id), ["removed"]);
	assert.equal(ledger.hasInflight(), false);
});

test("failed delivery immediately returns an event to the outbox", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-failed-"));
	const ledger = new NotificationLedger(root);
	const value = job();
	const event = terminal();
	ledger.sent(event);
	ledger.failed(event);
	assert.deepEqual(ledger.pending([value]), [event]);
});

test("a failed triggered run returns its started event to the outbox", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-run-failed-"));
	const ledger = new NotificationLedger(root);
	const value = job();
	const event = terminal();
	ledger.sent(event);
	assert.equal(ledger.started(event), true);
	assert.equal(ledger.retryStarted(), true);
	assert.deepEqual(ledger.pending([value]), [event]);
});

test("only complete NDJSON lines become running signals", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-lines-"));
	const path = jobPaths(root, "watch").eventsPath;
	mkdirSync(join(root, "jobs", "watch"), { recursive: true });
	appendFileSync(path, '{"type":"down","level":"error","message":"offline"}\n{"type":"up"');
	const events = readJobSignals(path);
	assert.equal(events.length, 1);
	assert.deepEqual(events[0], { sequence: 1, type: "down", level: "error", message: "offline", emittedAt: undefined, details: undefined });
});
