import { join } from "node:path";
import { atomicWriteJson, readJson, TERMINAL_STATUSES } from "./store.mjs";

function terminalEvent(job) {
	if (!TERMINAL_STATUSES.has(job.status) || !(job.eventSeq > 0)) return undefined;
	return {
		key: `${job.id}:terminal:${job.eventSeq}`,
		kind: "terminal",
		id: job.id,
		sequence: job.eventSeq,
		job,
	};
}

function signalEvents(job) {
	return (job.events ?? []).map((signal) => ({
		key: `${job.id}:signal:${signal.sequence}`,
		kind: "signal",
		id: job.id,
		sequence: signal.sequence,
		job,
		signal,
	}));
}

export class NotificationLedger {
	constructor(sessionDirectory, options = {}) {
		this.path = join(sessionDirectory, "notifications.json");
		this.values = readJson(this.path, {});
		this.inflight = new Map();
		this.now = options.now ?? (() => Date.now());
		this.retryAfterMs = options.retryAfterMs ?? 10_000;
	}

	acknowledged(event) {
		const value = this.values[event.id];
		if (typeof value === "number") return event.kind === "terminal" && event.sequence <= value;
		if (!value || typeof value !== "object") return false;
		const sequence = event.kind === "terminal" ? value.terminal ?? 0 : value.signal ?? 0;
		return event.sequence <= sequence;
	}

	events(jobs) {
		const events = [];
		for (const job of jobs) {
			events.push(...signalEvents(job));
			const terminal = terminalEvent(job);
			if (terminal) events.push(terminal);
		}
		return events.sort((left, right) => {
			if (left.id === right.id) {
				if (left.kind !== right.kind) return left.kind === "signal" ? -1 : 1;
				return left.sequence - right.sequence;
			}
			const leftTime = left.kind === "signal" ? left.signal.emittedAt ?? left.job.createdAt : left.job.finishedAt ?? left.job.createdAt;
			const rightTime = right.kind === "signal" ? right.signal.emittedAt ?? right.job.createdAt : right.job.finishedAt ?? right.job.createdAt;
			return leftTime - rightTime || left.key.localeCompare(right.key);
		});
	}

	unacknowledged(jobs) {
		return this.events(jobs).filter((event) => !this.acknowledged(event));
	}

	pending(jobs, options = {}) {
		const retryUnstarted = options.retryUnstarted === true;
		const now = this.now();
		return this.unacknowledged(jobs).filter((event) => {
			const delivery = this.inflight.get(event.key);
			if (!delivery) return true;
			return retryUnstarted && !delivery.started && now - delivery.sentAt >= this.retryAfterMs;
		});
	}

	next(jobs, options = {}) {
		const pending = this.pending(jobs, options);
		if (this.inflight.size === 0) return pending[0];
		return pending.find((event) => this.inflight.has(event.key));
	}

	hasInflight() {
		return this.inflight.size > 0;
	}

	sent(event) {
		this.inflight.set(event.key, { event, sentAt: this.now(), started: false });
	}

	started(event) {
		const delivery = event?.key ? this.inflight.get(event.key) : undefined;
		if (!delivery) return false;
		delivery.started = true;
		return true;
	}

	failed(event) {
		this.inflight.delete(event.key);
	}

	confirmStarted() {
		const confirmations = [];
		for (const delivery of this.inflight.values()) {
			if (delivery.started) confirmations.push(delivery.event);
		}
		if (confirmations.length === 0) return false;
		const values = readJson(this.path, {});
		for (const event of confirmations) {
			const existing = values[event.id];
			const normalized = typeof existing === "number" ? { terminal: existing, signal: 0 }
				: existing && typeof existing === "object" ? { terminal: existing.terminal ?? 0, signal: existing.signal ?? 0 }
				: { terminal: 0, signal: 0 };
			normalized[event.kind] = Math.max(event.sequence, normalized[event.kind]);
			values[event.id] = normalized;
		}
		atomicWriteJson(this.path, values);
		this.values = values;
		for (const event of confirmations) this.inflight.delete(event.key);
		return true;
	}

	retryStarted() {
		let changed = false;
		for (const [key, delivery] of this.inflight) {
			if (!delivery.started) continue;
			this.inflight.delete(key);
			changed = true;
		}
		return changed;
	}

	ack(value) {
		const event = value?.key ? value : terminalEvent(value);
		if (!event || this.acknowledged(event)) return false;
		const values = readJson(this.path, {});
		const existing = values[event.id];
		const normalized = typeof existing === "number" ? { terminal: existing, signal: 0 }
			: existing && typeof existing === "object" ? { terminal: existing.terminal ?? 0, signal: existing.signal ?? 0 }
			: { terminal: 0, signal: 0 };
		normalized[event.kind] = Math.max(event.sequence, normalized[event.kind]);
		values[event.id] = normalized;
		atomicWriteJson(this.path, values);
		this.values = values;
		this.inflight.delete(event.key);
		return true;
	}

	forget(id) {
		for (const [key, delivery] of this.inflight) {
			if (delivery.event.id === id) this.inflight.delete(key);
		}
		const values = readJson(this.path, {});
		if (!(id in values)) return;
		delete values[id];
		atomicWriteJson(this.path, values);
		this.values = values;
	}

	prune(jobs) {
		const retained = new Set(jobs.map((job) => job.id));
		for (const [key, delivery] of this.inflight) {
			if (!retained.has(delivery.event.id)) this.inflight.delete(key);
		}
		const values = readJson(this.path, {});
		let changed = false;
		for (const id of Object.keys(values)) {
			if (retained.has(id)) continue;
			delete values[id];
			changed = true;
		}
		if (changed) atomicWriteJson(this.path, values);
		this.values = values;
		return changed;
	}
}
