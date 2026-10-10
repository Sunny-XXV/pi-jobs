export const jobsPromptSnippet = "Run one durable background command and wake this session on sparse running events or terminal completion";

export const jobsPromptGuidelines = [
	"Use jobs run instead of agent-driven polling for long SQL, builds, and quiet watchdog loops. Simple long-task example: { action: \"run\", command: \"long-sql-command\", readiness: \"process\" }.",
	"When ending the turn depends on proof beyond a spawned PID, set readiness=signal and make the command touch $PI_JOB_READY only after remote submission is accepted or the watchdog completes its first successful health check.",
	"For a self-recovering watchdog, append NDJSON state transitions to $PI_JOB_EVENT so it can wake Pi while remaining alive; suppress repeated healthy-state messages. Example transition: printf '%s\\n' '{\"type\":\"service.disconnected\",\"level\":\"error\",\"message\":\"offline\"}' >> \"$PI_JOB_EVENT\".",
	"After a successful terminating run call, do not poll jobs yourself; wait for durable running or terminal events to wake the session.",
];
