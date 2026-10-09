import assert from "node:assert/strict";
import test from "node:test";
import { jobsCommandUsage, parseJobsCommand } from "../src/command.mjs";

test("jobs command opens the dashboard by default", () => {
	assert.deepEqual(parseJobsCommand(""), { action: "list" });
	assert.deepEqual(parseJobsCommand("list"), { action: "list" });
});

test("jobs command parses management actions", () => {
	for (const action of ["show", "stop", "retry", "remove"]) {
		assert.deepEqual(parseJobsCommand(`${action} abc123`), { action, id: "abc123" });
	}
});

test("jobs command rejects incomplete or extra arguments", () => {
	assert.deepEqual(parseJobsCommand("stop"), { action: "help" });
	assert.deepEqual(parseJobsCommand("show a b"), { action: "help" });
	assert.match(jobsCommandUsage(), /^\/jobs/);
});
