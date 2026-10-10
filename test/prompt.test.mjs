import assert from "node:assert/strict";
import test from "node:test";
import { jobsPromptGuidelines, jobsPromptSnippet } from "../src/prompt.mjs";

test("model-facing jobs guidance includes simple long-task and running-event examples", () => {
	const prompt = [jobsPromptSnippet, ...jobsPromptGuidelines].join("\n");
	assert.match(jobsPromptSnippet, /running events or terminal completion/);
	assert.match(prompt, /action: "run"/);
	assert.match(prompt, /readiness: "process"/);
	assert.match(prompt, /PI_JOB_READY/);
	assert.match(prompt, /PI_JOB_EVENT/);
	assert.match(prompt, /service\.disconnected/);
	assert.match(prompt, />> "\$PI_JOB_EVENT"/);
});
