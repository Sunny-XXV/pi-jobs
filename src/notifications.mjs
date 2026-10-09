import { join } from "node:path";
import { atomicWriteJson, readJson } from "./store.mjs";

export class NotificationLedger {
	constructor(sessionDirectory, options = {}) {
		this.path = join(sessionDirectory, "notifications.json");
		this.values = readJson(this.path, {});
		this.inflight = new Map();
		this.now = options.now ?? (() => Date.now());
		this.retryAfterMs = options.retryAfterMs ?? 10_000;
	}

	unacknowledged(jobs) {
		return jobs.filter((job) => (job.eventSeq ?? 0) > (this.values[job.id] ?? 0));
	}

	pending(jobs, options = {}) {
		const retryUnstarted = options.retryUnstarted === true;
		const now = this.now();
		return this.unacknowledged(jobs).filter((job) => {
			const sequence = job.eventSeq ?? 0;
			const delivery = this.inflight.get(job.id);
			if (!delivery || delivery.sequence < sequence) return true;
			return retryUnstarted && !delivery.started && now - delivery.sentAt >= this.retryAfterMs;
		});
	}

	next(jobs, options = {}) {
		const pending = this.pending(jobs, options);
		if (this.inflight.size === 0) return pending[0];
		return pending.find((job) => this.inflight.has(job.id));
	}

	hasInflight() {
		return this.inflight.size > 0;
	}

	sent(job) {
		this.inflight.set(job.id, { sequence: job.eventSeq ?? 0, sentAt: this.now(), started: false });
	}

	started(job) {
		const sequence = job?.eventSeq ?? 0;
		const delivery = job?.id ? this.inflight.get(job.id) : undefined;
		if (!delivery || delivery.sequence !== sequence) return false;
		delivery.started = true;
		return true;
	}

	failed(job) {
		const delivery = this.inflight.get(job.id);
		if (delivery?.sequence === (job.eventSeq ?? 0)) this.inflight.delete(job.id);
	}

	confirmStarted() {
		const confirmations = [];
		for (const [id, delivery] of this.inflight) {
			if (!delivery.started) continue;
			if (delivery.sequence > (this.values[id] ?? 0)) confirmations.push([id, delivery.sequence]);
		}
		if (confirmations.length === 0) return false;
		const values = readJson(this.path, {});
		for (const [id, sequence] of confirmations) values[id] = Math.max(sequence, values[id] ?? 0);
		atomicWriteJson(this.path, values);
		this.values = values;
		for (const [id] of confirmations) this.inflight.delete(id);
		return true;
	}

	retryStarted() {
		let changed = false;
		for (const [id, delivery] of this.inflight) {
			if (!delivery.started) continue;
			this.inflight.delete(id);
			changed = true;
		}
		return changed;
	}

	ack(job) {
		const sequence = job.eventSeq ?? 0;
		const values = readJson(this.path, {});
		if (sequence <= (values[job.id] ?? 0)) return false;
		values[job.id] = sequence;
		atomicWriteJson(this.path, values);
		this.values = values;
		this.inflight.delete(job.id);
		return true;
	}

	forget(id) {
		this.inflight.delete(id);
		const values = readJson(this.path, {});
		if (!(id in values)) return;
		delete values[id];
		atomicWriteJson(this.path, values);
		this.values = values;
	}

	prune(jobs) {
		const retained = new Set(jobs.map((job) => job.id));
		for (const id of this.inflight.keys()) {
			if (!retained.has(id)) this.inflight.delete(id);
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
