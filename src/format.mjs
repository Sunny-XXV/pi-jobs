export function age(job, now = Date.now()) {
	return Math.max(0, Math.round(((job.finishedAt ?? now) - job.createdAt) / 1000));
}

export function stateLabel(job) {
	return job.status === "waiting" ? "waiting" : job.status;
}

export function formatList(jobs) {
	if (!jobs.length) return "No background jobs in this session.";
	return jobs.map((job) => [
		job.id,
		String(job.mode).padEnd(5),
		String(stateLabel(job)).padEnd(9),
		String(job.attempts ?? 0).padStart(3) + "x",
		age(job) + "s",
		job.label,
	].join("  ")).join("\n");
}

export function formatDetails(job) {
	const lines = [
		"id: " + job.id,
		"label: " + job.label,
		"mode: " + job.mode,
		"status: " + stateLabel(job),
		"attempts: " + (job.attempts ?? 0),
		"elapsed_seconds: " + age(job),
		"cwd: " + job.cwd,
		"command: " + job.command,
	];
	if (job.parentId) lines.push("retried_from: " + job.parentId);
	if (job.runnerPid) lines.push("runner_pid: " + job.runnerPid);
	if (job.pid) lines.push("command_pid: " + job.pid);
	if (job.status === "waiting" && job.nextAttemptAt) lines.push("next_attempt_in_seconds: " + Math.max(0, Math.round((job.nextAttemptAt - Date.now()) / 1000)));
	if (!["completed", "failed", "timed_out", "stopped"].includes(job.status)) lines.push("deadline_in_seconds: " + Math.max(0, Math.round((job.deadlineAt - Date.now()) / 1000)));
	if (job.lastCode !== undefined) lines.push("exit_code: " + job.lastCode);
	if (job.lastSignal) lines.push("signal: " + job.lastSignal);
	if (job.error) lines.push("error: " + job.error);
	lines.push("", "stdout:", job.lastStdout || "(no stdout captured)");
	lines.push("", "stderr:", job.lastStderr || job.runnerStderr || "(no stderr captured)");
	return lines.join("\n").replace(/\r\n?/g, "\n");
}

export function formatEvent(job) {
	return [
		"[job event]",
		"id: " + job.id,
		"label: " + job.label,
		"mode: " + job.mode,
		"status: " + job.status,
		"attempts: " + job.attempts,
		"elapsed_seconds: " + age(job),
		job.lastCode !== undefined ? "exit_code: " + job.lastCode : undefined,
		job.error ? "error: " + job.error : undefined,
		job.lastStdout ? "stdout:\n" + clip(job.lastStdout, 6000) : undefined,
		job.lastStderr ? "stderr:\n" + clip(job.lastStderr, 3000) : undefined,
		"The background job reached a terminal state. Reassess the original task and report or continue as appropriate.",
	].filter(Boolean).join("\n");
}

function clip(text, limit) {
	return text.length <= limit ? text : "[...tail truncated...]\n" + text.slice(-limit);
}
