import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function registerRpcE2eProvider(pi: ExtensionAPI) {
	pi.registerProvider("pi-jobs-e2e", {
		baseUrl: "http://127.0.0.1",
		apiKey: "test",
		api: "pi-jobs-e2e-api",
		models: [{
			id: "tool-driver",
			name: "Pi Jobs E2E Tool Driver",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_000,
			maxTokens: 1_024,
		}],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const hasToolResult = context.messages.some((message: any) => message.role === "toolResult");
				const last = context.messages.at(-1) as any;
				const jobEvent = last?.role === "custom" && last.customType === "job-event" ? last : undefined;
				const content = hasToolResult || jobEvent
					? [{ type: "text", text: jobEvent ? `handled job ${jobEvent.details?.event?.id ?? "unknown"}` : "job submitted" }]
					: [{ type: "toolCall", id: "call-job", name: "jobs", arguments: {
						action: "run",
						command: `printf '%s\\n' '{"type":"service.disconnected","level":"error","message":"offline"}' >> "$PI_JOB_EVENT"; sleep 1; printf '%s\\n' '{"type":"service.recovered","level":"info","message":"online"}' >> "$PI_JOB_EVENT"; sleep 1; printf '%s\\n' '{"type":"service.disconnected","level":"error","message":"offline again"}' >> "$PI_JOB_EVENT"; sleep 1; printf done`,
						label: "rpc-e2e",
						timeout_seconds: 20,
						readiness: "process",
						terminate_turn: true,
					} }];
				const output: any = {
					role: "assistant",
					content,
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: content[0].type === "toolCall" ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: output });
				if (content[0].type === "toolCall") {
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: content[0], partial: output });
				} else {
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					stream.push({ type: "text_end", contentIndex: 0, content: content[0].text, partial: output });
				}
				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end();
			});
			return stream;
		},
	});
}
