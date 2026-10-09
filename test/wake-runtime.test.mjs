import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NotificationLedger } from "../src/notifications.mjs";
import { WakeRuntime } from "../src/wake-runtime.mjs";

function harness() {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-wake-runtime-"));
	const ledger = new NotificationLedger(root);
	const runtime = new WakeRuntime(ledger);
	const job = { id: "job-1", eventSeq: 1 };
	ledger.sent(job);
	return { ledger, runtime, job };
}

function injected(job) {
	return { role: "custom", customType: "job-event", details: job };
}

test("successful assistant completion followed by settlement acknowledges the wake", () => {
	const { ledger, runtime, job } = harness();
	assert.equal(runtime.messageStart(injected(job)), true);
	assert.equal(runtime.messageEnd({ role: "assistant", stopReason: "stop" }), true);
	assert.equal(runtime.settled({ aborted: false }), true);
	assert.deepEqual(ledger.pending([job]), []);
});

test("provider failure at message_end does not acknowledge the wake", () => {
	const { ledger, runtime, job } = harness();
	runtime.messageStart(injected(job));
	assert.equal(runtime.messageEnd({ role: "assistant", stopReason: "error" }), false);
	assert.equal(runtime.settled({ aborted: false }), false);
	assert.deepEqual(ledger.pending([job]), [job]);
});

test("an aborted settlement does not acknowledge a successful assistant message", () => {
	const { ledger, runtime, job } = harness();
	runtime.messageStart(injected(job));
	runtime.messageEnd({ role: "assistant", stopReason: "stop" });
	assert.equal(runtime.settled({ aborted: true }), false);
	assert.deepEqual(ledger.pending([job]), [job]);
});

test("a later failed assistant message overrides an earlier successful one", () => {
	const { ledger, runtime, job } = harness();
	runtime.messageStart(injected(job));
	runtime.messageEnd({ role: "assistant", stopReason: "stop" });
	runtime.messageEnd({ role: "assistant", stopReason: "aborted" });
	assert.equal(runtime.settled({ aborted: false }), false);
	assert.deepEqual(ledger.pending([job]), [job]);
});

test("unrelated custom messages cannot confirm an inflight wake", () => {
	const { ledger, runtime, job } = harness();
	assert.equal(runtime.messageStart({ role: "custom", customType: "other", details: job }), false);
	runtime.messageEnd({ role: "assistant", stopReason: "stop" });
	assert.equal(runtime.settled({ aborted: false }), false);
	assert.deepEqual(ledger.pending([job]), []);
});

test("a second job event cannot replace the active wake run", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-wake-runtime-second-"));
	const ledger = new NotificationLedger(root);
	const runtime = new WakeRuntime(ledger);
	const first = { id: "first", eventSeq: 1 };
	const second = { id: "second", eventSeq: 1 };
	ledger.sent(first);
	assert.equal(runtime.messageStart(injected(first)), true);
	assert.equal(runtime.messageStart(injected(second)), false);
	runtime.messageEnd({ role: "assistant", stopReason: "stop" });
	assert.equal(runtime.settled({ aborted: false }), true);
	assert.deepEqual(ledger.pending([first]), []);
	assert.deepEqual(ledger.pending([second]), [second]);
});
