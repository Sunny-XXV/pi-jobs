import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NotificationLedger } from "../src/notifications.mjs";
import { WakeRuntime } from "../src/wake-runtime.mjs";

function terminal(id = "job-1") {
	const job = { id, label: id, status: "completed", createdAt: 1, finishedAt: 2, eventSeq: 1, events: [] };
	return { key: `${id}:terminal:1`, kind: "terminal", id, sequence: 1, job };
}

function harness() {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-wake-runtime-"));
	const ledger = new NotificationLedger(root);
	const runtime = new WakeRuntime(ledger);
	const event = terminal();
	ledger.sent(event);
	return { ledger, runtime, event };
}

function injected(event) {
	return { role: "custom", customType: "job-event", details: { event } };
}

function jobs(event) {
	return [event.job];
}

test("successful assistant completion followed by settlement acknowledges the wake", () => {
	const { ledger, runtime, event } = harness();
	assert.equal(runtime.messageStart(injected(event)), true);
	assert.equal(runtime.messageEnd({ role: "assistant", stopReason: "stop" }), true);
	assert.equal(runtime.settled({ aborted: false }), true);
	assert.deepEqual(ledger.pending(jobs(event)), []);
});

test("provider failure at message_end does not acknowledge the wake", () => {
	const { ledger, runtime, event } = harness();
	runtime.messageStart(injected(event));
	assert.equal(runtime.messageEnd({ role: "assistant", stopReason: "error" }), false);
	assert.equal(runtime.settled({ aborted: false }), false);
	assert.deepEqual(ledger.pending(jobs(event)), [event]);
});

test("an aborted settlement does not acknowledge a successful assistant message", () => {
	const { ledger, runtime, event } = harness();
	runtime.messageStart(injected(event));
	runtime.messageEnd({ role: "assistant", stopReason: "stop" });
	assert.equal(runtime.settled({ aborted: true }), false);
	assert.deepEqual(ledger.pending(jobs(event)), [event]);
});

test("a later failed assistant message overrides an earlier successful one", () => {
	const { ledger, runtime, event } = harness();
	runtime.messageStart(injected(event));
	runtime.messageEnd({ role: "assistant", stopReason: "stop" });
	runtime.messageEnd({ role: "assistant", stopReason: "aborted" });
	assert.equal(runtime.settled({ aborted: false }), false);
	assert.deepEqual(ledger.pending(jobs(event)), [event]);
});

test("unrelated custom messages cannot confirm an inflight wake", () => {
	const { ledger, runtime, event } = harness();
	assert.equal(runtime.messageStart({ role: "custom", customType: "other", details: { event } }), false);
	runtime.messageEnd({ role: "assistant", stopReason: "stop" });
	assert.equal(runtime.settled({ aborted: false }), false);
	assert.deepEqual(ledger.pending(jobs(event)), []);
});

test("a second job event cannot replace the active wake run", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-wake-runtime-second-"));
	const ledger = new NotificationLedger(root);
	const runtime = new WakeRuntime(ledger);
	const first = terminal("first");
	const second = terminal("second");
	ledger.sent(first);
	assert.equal(runtime.messageStart(injected(first)), true);
	assert.equal(runtime.messageStart(injected(second)), false);
	runtime.messageEnd({ role: "assistant", stopReason: "stop" });
	assert.equal(runtime.settled({ aborted: false }), true);
	assert.deepEqual(ledger.pending([first.job]), []);
	assert.deepEqual(ledger.pending([second.job]), [second]);
});
