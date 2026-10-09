export function age(job, now = Date.now()) {
	return Math.max(0, Math.round(((job.finishedAt ?? now) - job.createdAt) / 1000));
}

export function formatList(jobs) {
	if (!jobs.length) return "No background jobs in this session.";
	return jobs.map((job) => [
		job.id,
		String(job.status).padEnd(9),
		age(job) + "s",
		job.label,
	].join("  ")).join("\n");
}

export function formatDetails(job) {
	const lines = [
		"id: " + job.id,
		"label: " + job.label,
		"status: " + job.status,
		"elapsed_seconds: " + age(job),
		"cwd: " + job.cwd,
		"command: " + job.command,
	];
	if (job.parentId) lines.push("retried_from: " + job.parentId);
	if (job.runnerPid) lines.push("runner_pid: " + job.runnerPid);
	if (job.pid) lines.push("command_pid: " + job.pid);
	if (!["completed", "failed", "timed_out", "stopped"].includes(job.status)) lines.push("deadline_in_seconds: " + Math.max(0, Math.round((job.deadlineAt - Date.now()) / 1000)));
	if (job.exitCode !== undefined) lines.push("exit_code: " + job.exitCode);
	if (job.signal) lines.push("signal: " + job.signal);
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
		"status: " + job.status,
		"elapsed_seconds: " + age(job),
		job.exitCode !== undefined ? "exit_code: " + job.exitCode : undefined,
		job.error ? "error: " + job.error : undefined,
		job.lastStdout ? "stdout:\n" + clip(job.lastStdout, 6000) : undefined,
		job.lastStderr ? "stderr:\n" + clip(job.lastStderr, 3000) : undefined,
		"The background job reached a terminal state. Reassess the original task and report or continue as appropriate.",
	].filter(Boolean).join("\n");
}

function clip(text, limit) {
	return text.length <= limit ? text : "[...tail truncated...]\n" + text.slice(-limit);
}
