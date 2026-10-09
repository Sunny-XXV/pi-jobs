export class WakeRuntime {
	constructor(ledger) {
		this.ledger = ledger;
		this.active = false;
		this.assistantCompleted = false;
	}

	messageStart(message) {
		if (this.active || message?.role !== "custom" || message.customType !== "job-event") return false;
		if (!this.ledger.started(message.details?.event)) return false;
		this.active = true;
		this.assistantCompleted = false;
		return true;
	}

	messageEnd(message) {
		if (!this.active || message?.role !== "assistant") return false;
		this.assistantCompleted = message.stopReason !== "error" && message.stopReason !== "aborted";
		return this.assistantCompleted;
	}

	settled(event = {}) {
		if (!this.active) return false;
		const confirmed = !event.aborted && this.assistantCompleted;
		if (confirmed) this.ledger.confirmStarted();
		else this.ledger.retryStarted();
		this.active = false;
		this.assistantCompleted = false;
		return confirmed;
	}

	reset() {
		this.active = false;
		this.assistantCompleted = false;
	}
}
