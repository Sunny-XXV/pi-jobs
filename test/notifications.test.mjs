import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NotificationLedger } from "../src/notifications.mjs";

function job(id = "job-1", eventSeq = 1) {
	return { id, eventSeq };
}

test("only one terminal wake is active at a time", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-next-"));
	const ledger = new NotificationLedger(root);
	const first = job("first");
	const second = job("second");
	assert.equal(ledger.next([first, second]).id, "first");
	ledger.sent(first);
	assert.equal(ledger.next([first, second]), undefined);
	assert.equal(ledger.started(first), true);
	assert.equal(ledger.confirmStarted(), true);
	assert.equal(ledger.next([first, second]).id, "second");
});

test("terminal wake stays pending until its triggered run starts and completes", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-"));
	const ledger = new NotificationLedger(root);
	const event = job();
	assert.deepEqual(ledger.pending([event]), [event]);
	ledger.sent(event);
	assert.deepEqual(ledger.pending([event]), []);
	assert.equal(ledger.started(event), true);
	assert.equal(ledger.confirmStarted(), true);
	assert.deepEqual(ledger.pending([event]), []);
	const reloaded = new NotificationLedger(root);
	assert.deepEqual(reloaded.pending([event]), []);
});

test("an unconfirmed terminal wake is redelivered instead of silently acknowledged", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-redeliver-"));
	let now = 1_000;
	const ledger = new NotificationLedger(root, { now: () => now, retryAfterMs: 100 });
	const event = job();
	ledger.sent(event);
	assert.equal(ledger.hasInflight(), true);
	assert.deepEqual(ledger.pending([event], { retryUnstarted: true }), []);
	now += 101;
	assert.deepEqual(ledger.pending([event], { retryUnstarted: true }), [event]);
	const reloaded = new NotificationLedger(root);
	assert.deepEqual(reloaded.pending([event]), [event]);
});

test("acknowledgments from multiple extension runtimes merge instead of overwriting", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-merge-"));
	const firstLedger = new NotificationLedger(root);
	const secondLedger = new NotificationLedger(root);
	const first = job("first");
	const second = job("second");
	assert.equal(firstLedger.ack(first), true);
	assert.equal(secondLedger.ack(second), true);
	const reloaded = new NotificationLedger(root);
	assert.deepEqual(reloaded.pending([first, second]), []);
});

test("failed delivery immediately returns an event to the outbox", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-failed-"));
	const ledger = new NotificationLedger(root);
	const event = job();
	ledger.sent(event);
	ledger.failed(event);
	assert.deepEqual(ledger.pending([event]), [event]);
});

test("a failed triggered run returns its started event to the outbox", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-notify-run-failed-"));
	const ledger = new NotificationLedger(root);
	const event = job();
	ledger.sent(event);
	assert.equal(ledger.started(event), true);
	assert.equal(ledger.retryStarted(), true);
	assert.deepEqual(ledger.pending([event]), [event]);
});
