const USAGE = "/jobs [list | show <id> | stop <id|all> | retry <id> | remove <id|finished>]";

export function jobsCommandUsage() {
	return USAGE;
}

export function parseJobsCommand(input = "") {
	const parts = input.trim().split(/\s+/).filter(Boolean);
	if (!parts.length || parts[0] === "list") return { action: "list" };
	if (["show", "stop", "retry", "remove"].includes(parts[0]) && parts.length === 2) return { action: parts[0], id: parts[1] };
	return { action: "help" };
}
