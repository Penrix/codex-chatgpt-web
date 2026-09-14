const fs = require("node:fs");

function replaceExactlyOnce(file, before, after, label) {
  const source = fs.readFileSync(file, "utf8");
  const usesCrlf = source.includes("\r\n");
  const normalized = source.replace(/\r\n/g, "\n");
  const first = normalized.indexOf(before);
  if (first < 0) throw new Error(`${label}: expected source block was not found in ${file}`);
  if (normalized.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected source block is ambiguous in ${file}`);
  }
  const patched = normalized.slice(0, first) + after + normalized.slice(first + before.length);
  fs.writeFileSync(file, usesCrlf ? patched.replace(/\n/g, "\r\n") : patched);
}

const promptPath = "src/adapters/chatgpt-web/prompt.ts";
const adapterPath = "src/adapters/chatgpt-web/index.ts";

replaceExactlyOnce(
  promptPath,
  `import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";`,
  `import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";\nimport { chatGptDirectToolProtocolLines } from "./direct-tools";`,
  "direct tool prompt import",
);

replaceExactlyOnce(
  promptPath,
  `  manualControl?: true;\n}`,
  `  manualControl?: true;\n  /** Automatic Web mode: Codex executes tools from a strict browser JSON envelope; no MCP connector. */\n  directTools?: true;\n}`,
  "direct tool compile option",
);

replaceExactlyOnce(
  promptPath,
  `  const manualControl = options?.manualControl === true;\n  const mode = manualControl`,
  `  const manualControl = options?.manualControl === true;\n  const directTools = options?.directTools === true;\n  if (manualControl && directTools) throw new Error("Zero Risk cannot use the automatic direct tool protocol");\n  const mode = manualControl`,
  "direct tool option activation",
);

replaceExactlyOnce(
  promptPath,
  `  if (mode.localTools && !turnToken) {\n    throw new Error(manualControl\n      ? "ChatGPT Zero Risk requires a broker request id"\n      : "Tool-capable ChatGPT web mode requires a broker turn token");\n  }\n  if (!mode.localTools && turnToken !== undefined) {\n    throw new Error("A read-only ChatGPT Web effort must not receive a local-tool capability token");\n  }`,
  `  if (mode.localTools && !directTools && !turnToken) {\n    throw new Error(manualControl\n      ? "ChatGPT Zero Risk requires a broker request id"\n      : "Tool-capable ChatGPT web mode requires a broker turn token");\n  }\n  if ((!mode.localTools || directTools) && turnToken !== undefined) {\n    throw new Error(directTools\n      ? "Direct ChatGPT Web tools must not receive an MCP capability token"\n      : "A read-only ChatGPT Web effort must not receive a local-tool capability token");\n  }`,
  "direct tool capability token boundary",
);

replaceExactlyOnce(
  promptPath,
  `    : mode.localTools\n    ? [\n      "For local work required by the task, use the attached Codex Native tools directly according to their declared descriptions and schemas.",\n      "Call a Codex Native tool only when the latest active request requires a local effect or fresh local evidence that is not already present in the supplied context; otherwise answer the request directly without a tool call.",\n      "Use actual Codex Native results as evidence for local observations and effects.",\n      "A Codex Native MCP tool result may require context compaction. If it does, follow the compaction instructions in that result exactly.",\n      "After a deterministic tool failure, update the working hypothesis from that result and inspect the relevant repository or environment before choosing a different next action; do not repeat the same call unless its inputs or observable state changed.",\n      "Continue using the available tools until the requested work is complete and verified.",\n      "Write the user-facing final answer only after the last required tool result has settled. Do not call another tool after beginning that final answer.",\n    ]\n    : [`,
  `    : mode.localTools\n    ? directTools\n      ? chatGptDirectToolProtocolLines(parsed)\n      : [\n        "For local work required by the task, use the attached Codex Native tools directly according to their declared descriptions and schemas.",\n        "Call a Codex Native tool only when the latest active request requires a local effect or fresh local evidence that is not already present in the supplied context; otherwise answer the request directly without a tool call.",\n        "Use actual Codex Native results as evidence for local observations and effects.",\n        "A Codex Native MCP tool result may require context compaction. If it does, follow the compaction instructions in that result exactly.",\n        "After a deterministic tool failure, update the working hypothesis from that result and inspect the relevant repository or environment before choosing a different next action; do not repeat the same call unless its inputs or observable state changed.",\n        "Continue using the available tools until the requested work is complete and verified.",\n        "Write the user-facing final answer only after the last required tool result has settled. Do not call another tool after beginning that final answer.",\n      ]\n    : [`,
  "direct tool transport contract",
);

replaceExactlyOnce(
  promptPath,
  `    : mode.localTools\n    ? [\n      "<codex_transport_resume>",\n      \`The task context is complete. Pass turn_token \${turnToken} unchanged to every Codex Native call in this response, including continuations after tool results; do not expose it in the answer. Execute the latest active user request now.\`,\n      "</codex_transport_resume>",\n    ]\n    : [`,
  `    : mode.localTools\n    ? directTools\n      ? [\n        "<codex_transport_resume>",\n        "The task context is complete. Execute the latest active user request now. If local work is needed, end this browser response with the exact tool_calls JSON envelope; Codex will execute it and return the result in the next round.",\n        "</codex_transport_resume>",\n      ]\n      : [\n        "<codex_transport_resume>",\n        \`The task context is complete. Pass turn_token \${turnToken} unchanged to every Codex Native call in this response, including continuations after tool results; do not expose it in the answer. Execute the latest active user request now.\`,\n        "</codex_transport_resume>",\n      ]\n    : [`,
  "direct tool transport resume",
);

replaceExactlyOnce(
  promptPath,
  `    const answerContract = captureLunaCheckpoint\n      ? "Return the complete answer that the outer Codex task should receive, then the required private checkpoint tail."\n      : "Return only the answer that the outer Codex task should receive.";`,
  `    const answerContract = directTools\n      ? "Return only the single Codex browser tool protocol JSON object required above."\n      : captureLunaCheckpoint\n        ? "Return the complete answer that the outer Codex task should receive, then the required private checkpoint tail."\n        : "Return only the answer that the outer Codex task should receive.";`,
  "direct tool answer contract",
);

replaceExactlyOnce(
  adapterPath,
  `import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "./prompt";`,
  `import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "./prompt";\nimport { parseChatGptDirectToolOutcome } from "./direct-tools";`,
  "direct tool adapter import",
);

replaceExactlyOnce(
  adapterPath,
  `    const mode = manualRequest\n      ? { localTools: true }\n      : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);\n    const identity = extractChatGptTurnIdentity(parsed);`,
  `    const mode = manualRequest\n      ? { localTools: true }\n      : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);\n    // Sol/High can hand tool selection back to native Codex through the Responses round-trip.\n    // Luna keeps its existing MCP path because its rolling-checkpoint tail is not a single JSON envelope.\n    const directTools = !manualRequest && mode.localTools && parsed.modelId === CHATGPT_WEB_MODEL_ID;\n    const identity = extractChatGptTurnIdentity(parsed);`,
  "direct tool runtime selection",
);

replaceExactlyOnce(
  adapterPath,
  `      && mode.localTools\n      && retainedLauncherDescriptor`,
  `      && mode.localTools\n      && !directTools\n      && retainedLauncherDescriptor`,
  "direct tool retained conversation isolation",
);

replaceExactlyOnce(
  adapterPath,
  `      };\n    }\n    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");`,
  `      };\n    }\n    if (directTools) {\n      const browserCapabilities = { ...turnCapabilities, localToolsEnabled: false };\n      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({\n        traceId,\n        modelId: parsed.modelId,\n        reasoning: parsed.options.reasoning,\n        // Browser-local tools are deliberately disabled: the JSON envelope is translated back to\n        // native Codex, which remains the only local executor. This also avoids connector selection.\n        capabilities: browserCapabilities,\n        prepare: async () => ({\n          ...compileChatGptWebPrompt(\n            checkpointInput.parsed,\n            turnCapabilities,\n            undefined,\n            { ...compileOptionsFor(checkpointInput.parsed), directTools: true },\n          ),\n          release: () => {},\n        }),\n        abortSignal: browserAbort.signal,\n        ...submissionLifecycle,\n        ...multipartProgressLifecycle,\n        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),\n        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),\n        // Keep the protocol JSON private. runTurn parses the completed buffer and emits either\n        // native tool_call events or only the final envelope content.\n        onTextDelta: delta => text.push(delta),\n      })), browserAbort);\n      return {\n        mode: "read-only",\n        browser: browserTurn.browser,\n        physicalSettlement: browserTurn.physicalSettlement,\n        trace,\n        text,\n        usageInput: checkpointInput.parsed,\n        submission,\n        cancel: browserTurn.cancel,\n      };\n    }\n    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");`,
  "direct tool browser runtime",
);

replaceExactlyOnce(
  adapterPath,
  `        const mode = manualRequest\n          ? { localTools: true }\n          : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);\n        const structuredOutputValidator = parsed._compactionRequest`,
  `        const mode = manualRequest\n          ? { localTools: true }\n          : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);\n        const directTools = !manualRequest && mode.localTools && parsed.modelId === CHATGPT_WEB_MODEL_ID;\n        const structuredOutputValidator = parsed._compactionRequest`,
  "direct tool request selection",
);

replaceExactlyOnce(
  adapterPath,
  `        if (mode.localTools) {\n          try {\n            environment = environmentStore.resolve(parsed);`,
  `        if (mode.localTools && !directTools) {\n          try {\n            environment = environmentStore.resolve(parsed);`,
  "direct tool environment independence",
);

replaceExactlyOnce(
  adapterPath,
  `          const structuredCompactionRequired = parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID\n            && configuredCapabilities.localToolsEnabled;`,
  `          const structuredCompactionRequired = manualRequest\n            && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID\n            && configuredCapabilities.localToolsEnabled;`,
  "direct tool compaction isolation",
);

replaceExactlyOnce(
  adapterPath,
  `        const executionKey = \`\${executionNamespace}:\${chatGptTurnExecutionKey(parsed)}\`;\n        const ownerKey = \`\${executionNamespace}:\${chatGptThreadOwnershipKey(parsed)}\`;`,
  `        const roundKey = chatGptTurnRoundKey(parsed);\n        // A direct browser tool response completes at every native tool boundary. Give each\n        // canonical Responses round its own replayable browser session while retaining one owner.\n        const executionKey = directTools\n          ? \`\${executionNamespace}:direct:\${roundKey}\`\n          : \`\${executionNamespace}:\${chatGptTurnExecutionKey(parsed)}\`;\n        const ownerKey = \`\${executionNamespace}:\${chatGptThreadOwnershipKey(parsed)}\`;`,
  "direct tool round execution identity",
);

replaceExactlyOnce(
  adapterPath,
  `        const traceId = chatGptWebTraceId(provider, parsed);`,
  `        const traceId = directTools\n          ? createHash("sha256").update(executionKey).digest("hex").slice(0, 12)\n          : chatGptWebTraceId(provider, parsed);`,
  "direct tool trace identity",
);

replaceExactlyOnce(
  adapterPath,
  `        const roundKey = chatGptTurnRoundKey(parsed);\n        const emitRoundEvents = (events: readonly AdapterEvent[]): void => {`,
  `        const emitRoundEvents = (events: readonly AdapterEvent[]): void => {`,
  "deduplicate round key",
);

replaceExactlyOnce(
  adapterPath,
  `            const settled = session.settledOutcome();`,
  `            const finishDirectBrowserAnswer = (rawAnswer: string, reasoning: string[]): void => {\n              if (session.runtime.text.value() !== rawAnswer) {\n                throw new Error("ChatGPT browser protocol stream did not reproduce the completed answer");\n              }\n              const direct = parseChatGptDirectToolOutcome(rawAnswer, parsed, roundKey);\n              if (direct.kind === "tool_calls") {\n                validateBatchTools(parsed, direct.requests);\n                emitRoundBatch(buffer => emitToolBatch(\n                  direct.requests,\n                  estimateChatGptWebUsage(\n                    currentUsageInput(parsed),\n                    { reasoning, toolRequests: direct.requests },\n                    turnCapabilities,\n                    experimentalBiggerContext,\n                  ),\n                  buffer,\n                ));\n                session.completeRound(roundKey);\n                chatGptWebTurnRetryPolicy.clear(retryKey);\n                return;\n              }\n              structuredOutputValidator?.(direct.content);\n              emitRoundBatch(buffer => emitTextDeltas([direct.content], buffer));\n              session.setFinalReasoning(reasoning);\n              session.setFinalEvents(session.roundEvents(roundKey));\n              emitRoundBatch(buffer => emitBrowserCompletion(\n                { type: "final", answer: direct.content },\n                estimateChatGptWebUsage(\n                  currentUsageInput(parsed),\n                  { answer: rawAnswer, reasoning },\n                  turnCapabilities,\n                  experimentalBiggerContext,\n                ),\n                buffer,\n              ));\n              session.completeRound(roundKey);\n              chatGptWebTurnRetryPolicy.clear(retryKey);\n            };\n\n            const settled = session.settledOutcome();`,
  "direct tool outcome finisher",
);

replaceExactlyOnce(
  adapterPath,
  `              const trace = session.runtime.trace.drain();\n              const completedTextDeltas = session.runtime.text.drain();\n              const finalReplay = replay.length === 0`,
  `              const trace = session.runtime.trace.drain();\n              const completedTextDeltas = session.runtime.text.drain();\n              if (directTools) {\n                session.appendRoundReasoning(roundKey, trace.map(event => event.text));\n                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));\n                finishDirectBrowserAnswer(settled.answer, session.roundReasoning(roundKey));\n                return;\n              }\n              const finalReplay = replay.length === 0`,
  "direct tool settled response",
);

replaceExactlyOnce(
  adapterPath,
  `            let turnToken: string | undefined;\n            if (session.runtime.mode === "tools") {`,
  `            if (directTools) {\n              const initialTrace = session.runtime.trace.drain();\n              session.appendRoundReasoning(roundKey, initialTrace.map(event => event.text));\n              emitRoundBatch(buffer => emitTraceEvents(initialTrace, buffer));\n              // Drain protocol fragments without exposing them through Codex's user-facing stream.\n              session.runtime.text.drain();\n              const directOutcome = await withAbort(session.browserOutcome, incoming.abortSignal);\n              const finalTrace = session.runtime.trace.drain();\n              session.appendRoundReasoning(roundKey, finalTrace.map(event => event.text));\n              emitRoundBatch(buffer => emitTraceEvents(finalTrace, buffer));\n              session.runtime.text.drain();\n              if (directOutcome.type === "error") throw directOutcome.error;\n              finishDirectBrowserAnswer(directOutcome.answer, session.roundReasoning(roundKey));\n              return;\n            }\n\n            let turnToken: string | undefined;\n            if (session.runtime.mode === "tools") {`,
  "direct tool active response",
);

const prompt = fs.readFileSync(promptPath, "utf8");
const adapter = fs.readFileSync(adapterPath, "utf8");
if (!prompt.includes("chatGptDirectToolProtocolLines(parsed)")) {
  throw new Error("V8 direct tool prompt contract is missing");
}
if (!adapter.includes("parseChatGptDirectToolOutcome(rawAnswer, parsed, roundKey)")) {
  throw new Error("V8 direct tool response parser is missing");
}
if (!adapter.includes("capabilities: browserCapabilities")) {
  throw new Error("V8 direct browser runtime still requires browser-local connector capabilities");
}
if (!adapter.includes("`${executionNamespace}:direct:${roundKey}`")) {
  throw new Error("V8 direct tool rounds do not own distinct replay identities");
}

process.stdout.write("V8_DIRECT_TOOLS_HOTFIX_APPLIED\n");
