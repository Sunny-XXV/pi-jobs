import { atomicWriteJson, readJson } from "./store.mjs";
import { join } from "node:path";

export class NotificationLedger {
	constructor(sessionDirectory) {
		this.path = join(sessionDirectory, "notifications.json");
		this.values = readJson(this.path, {});
	}

	pending(jobs) {
		return jobs.filter((job) => (job.eventSeq ?? 0) > (this.values[job.id] ?? 0));
	}

	ack(job) {
		const sequence = job.eventSeq ?? 0;
		if (sequence <= (this.values[job.id] ?? 0)) return false;
		this.values[job.id] = sequence;
		atomicWriteJson(this.path, this.values);
		return true;
	}

	forget(id) {
		if (!(id in this.values)) return;
		delete this.values[id];
		atomicWriteJson(this.path, this.values);
	}
}
