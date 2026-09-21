import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compactionSummaryFromReplacementHistory,
  loadWebCodexContinuityConfig,
  WebCodexContinuityBridge,
  WebCodexContinuityError,
  type WebCodexContinuityConfig,
} from "../src/continuity/webcodex";

const roots: string[] = [];

function tempStatePath(): string {
  const root = mkdtempSync(join(tmpdir(), "cgw-webcodex-continuity-"));
  roots.push(root);
  return join(root, "bindings.json");
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function config(statePath = tempStatePath()): WebCodexContinuityConfig {
  const tokenFile = join(statePath, "..", "webcodex-token");
  writeFileSync(tokenFile, "test-secret-token\n", { mode: 0o600 });
  return {
    baseUrl: "http://127.0.0.1:9876",
    tokenFile,
    project: "agent:test:project",
    statePath,
  };
}

function jsonResponse(output: unknown, status = 200): Response {
  return Response.json(
    status < 400 ? { success: true, output, error: null } : { success: false, output: {}, error: "failed" },
    { status },
  );
}

function goalOutput(goalId: string, revision: number): Record<string, unknown> {
  return {
    goal: {
      summary: {
        goal_id: goalId,
        revision,
        lifecycle: "active",
      },
    },
  };
}

describe("WebCodex continuity config", () => {
  test("is disabled when no WebCodex variables are present", () => {
    expect(loadWebCodexContinuityConfig(tempStatePath(), {})).toBeUndefined();
  });

  test("rejects partial configuration instead of guessing", () => {
    expect(() => loadWebCodexContinuityConfig(tempStatePath(), {
      CODEX_CHATGPT_WEB_WEBCODEX_URL: "http://127.0.0.1:9876",
      CODEX_CHATGPT_WEB_WEBCODEX_TOKEN_FILE: "/tmp/missing-token-file",
    })).toThrow(WebCodexContinuityError);
  });

  test("keeps only the WebCodex token-file path in config", () => {
    const statePath = tempStatePath();
    const tokenPath = join(statePath, "..", "webcodex.token");
    writeFileSync(tokenPath, "file-secret-token\n");
    const loaded = loadWebCodexContinuityConfig(statePath, {
      CODEX_CHATGPT_WEB_WEBCODEX_URL: "http://127.0.0.1:9876",
      CODEX_CHATGPT_WEB_WEBCODEX_TOKEN_FILE: tokenPath,
      CODEX_CHATGPT_WEB_WEBCODEX_PROJECT: "agent:test:project",
    });
    expect(loaded?.tokenFile).toBe(tokenPath);
    expect(loaded?.project).toBe("agent:test:project");
    expect("token" in (loaded ?? {})).toBe(false);
  });
});

describe("WebCodex continuity binding", () => {
  test("extracts the real compaction summary rather than checkpointing transport prose", () => {
    const summary = compactionSummaryFromReplacementHistory([
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\nCurrent decision: keep the Provider thin.\nNext: run cross-thread recovery.",
        }],
      },
    ]);
    expect(summary).toBe("Current decision: keep the Provider thin.\nNext: run cross-thread recovery.");
  });

  test("binds one external task to an exact durable Goal and Workflow Session", async () => {
    const calls: Array<{ tool: string; params: Record<string, unknown>; authorization: string | null }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { tool: string; params: Record<string, unknown> };
      calls.push({
        ...body,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (body.tool === "create_goal") return jsonResponse(goalOutput("wc_goal_1234567890abcdef", 1));
      if (body.tool === "work_on_project") {
        return jsonResponse({ session: { session_id: "wc_sess_1234567890abcdef" } });
      }
      if (body.tool === "associate_goal_workflow_session") {
        return jsonResponse(goalOutput("wc_goal_1234567890abcdef", 1));
      }
      throw new Error(`unexpected tool ${body.tool}`);
    };

    const cfg = config();
    const bridge = new WebCodexContinuityBridge(cfg, fetchImpl);
    const binding = await bridge.bindTask("thread_abc", "Fix the continuity boundary without rebuilding the runtime.");

    expect(binding.externalTaskId).toBe("thread_abc");
    expect(binding.goalId).toBe("wc_goal_1234567890abcdef");
    expect(binding.workflowSessionId).toBe("wc_sess_1234567890abcdef");
    expect(calls.map(call => call.tool)).toEqual([
      "create_goal",
      "work_on_project",
      "associate_goal_workflow_session",
    ]);
    expect(calls[0]!.params.completion_conditions).toEqual([]);
    expect(calls[0]!.params.steps).toEqual([]);
    expect(calls[1]!.params.project).toBe("agent:test:project");
    expect(calls[2]!.params.goal_id).toBe(binding.goalId);
    expect(calls[2]!.params.session_id).toBe(binding.workflowSessionId);
    expect(calls.every(call => call.authorization === "Bearer test-secret-token")).toBe(true);

    const persisted = readFileSync(cfg.statePath, "utf8");
    expect(persisted).toContain(binding.goalId);
    expect(persisted).toContain(binding.workflowSessionId);
    expect(persisted).not.toContain("test-secret-token");
    expect(persisted).not.toContain("Fix the continuity boundary without rebuilding the runtime.");

    const second = await bridge.bindTask("thread_abc", "A different prompt must not silently retarget existing durable work.");
    expect(second).toEqual(binding);
    expect(calls).toHaveLength(3);
  });

  test("sanitizes legacy binding files so old prompt text is not re-persisted", async () => {
    const cfg = config();
    writeFileSync(cfg.statePath, JSON.stringify({
      version: 1,
      bindings: {
        thread_legacy: {
          version: 1,
          externalTaskId: "thread_legacy",
          project: "agent:test:project",
          goalId: "wc_goal_9999999999999999",
          workflowSessionId: "wc_sess_8888888888888888",
          goalRevision: 2,
          objective: "legacy prompt text that must be dropped",
          createdAt: "2026-09-21T00:00:00.000Z",
          updatedAt: "2026-09-21T00:00:00.000Z"
        }
      }
    }));

    const bridge = new WebCodexContinuityBridge(cfg, async () => {
      throw new Error("network should not be used");
    });
    const adopted = bridge.adoptTask("thread_legacy_new", "thread_legacy");
    expect(adopted.goalId).toBe("wc_goal_9999999999999999");
    const persisted = readFileSync(cfg.statePath, "utf8");
    expect(persisted).not.toContain("legacy prompt text that must be dropped");
    expect(persisted).not.toContain("objective");
  });

  test("adoption is explicit and preserves exact durable identities", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { tool: string };
      if (body.tool === "create_goal") return jsonResponse(goalOutput("wc_goal_aaaaaaaaaaaaaaaa", 1));
      if (body.tool === "work_on_project") return jsonResponse({ session: { session_id: "wc_sess_bbbbbbbbbbbbbbbb" } });
      if (body.tool === "associate_goal_workflow_session") return jsonResponse(goalOutput("wc_goal_aaaaaaaaaaaaaaaa", 1));
      throw new Error(`unexpected tool ${body.tool}`);
    };
    const bridge = new WebCodexContinuityBridge(config(), fetchImpl);
    const oldBinding = await bridge.bindTask("thread_old", "Continue one durable coding task.");
    const adopted = bridge.adoptTask("thread_new", "thread_old");

    expect(adopted.goalId).toBe(oldBinding.goalId);
    expect(adopted.workflowSessionId).toBe(oldBinding.workflowSessionId);
    expect(adopted.adoptedFromTaskId).toBe("thread_old");
    expect(bridge.getBinding("thread_new")).toEqual(adopted);
  });

  test("checkpoint refreshes the authoritative Goal revision before mutating", async () => {
    const observed: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { tool: string; params: Record<string, unknown> };
      observed.push(body);
      if (body.tool === "create_goal") return jsonResponse(goalOutput("wc_goal_cccccccccccccccc", 1));
      if (body.tool === "work_on_project") return jsonResponse({ session: { session_id: "wc_sess_dddddddddddddddd" } });
      if (body.tool === "associate_goal_workflow_session") return jsonResponse(goalOutput("wc_goal_cccccccccccccccc", 1));
      if (body.tool === "get_goal") return jsonResponse(goalOutput("wc_goal_cccccccccccccccc", 4));
      if (body.tool === "checkpoint_goal") {
        expect(body.params.expected_revision).toBe(4);
        expect(body.params.summary).toBe("Current direction is verified; next step is recovery dogfood.");
        return jsonResponse(goalOutput("wc_goal_cccccccccccccccc", 5));
      }
      throw new Error(`unexpected tool ${body.tool}`);
    };
    const bridge = new WebCodexContinuityBridge(config(), fetchImpl);
    await bridge.bindTask("thread_checkpoint", "Build the recovery slice.");
    const updated = await bridge.checkpointTask(
      "thread_checkpoint",
      "Current direction is verified; next step is recovery dogfood.",
    );

    expect(updated.goalRevision).toBe(5);
    expect(observed.slice(-2).map(call => call.tool)).toEqual(["get_goal", "checkpoint_goal"]);
  });

  test("recovery reads exact Goal and exact Session handoff without inferring either", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { tool: string; params: Record<string, unknown> };
      if (body.tool === "create_goal") return jsonResponse(goalOutput("wc_goal_eeeeeeeeeeeeeeee", 1));
      if (body.tool === "work_on_project") return jsonResponse({ session: { session_id: "wc_sess_ffffffffffffffff" } });
      if (body.tool === "associate_goal_workflow_session") return jsonResponse(goalOutput("wc_goal_eeeeeeeeeeeeeeee", 1));
      if (body.tool === "get_goal") {
        expect(body.params.goal_id).toBe("wc_goal_eeeeeeeeeeeeeeee");
        return jsonResponse(goalOutput("wc_goal_eeeeeeeeeeeeeeee", 3));
      }
      if (body.tool === "session_handoff_summary") {
        expect(body.params.session_id).toBe("wc_sess_ffffffffffffffff");
        expect(body.params.project).toBe("agent:test:project");
        return jsonResponse({
          handoff_brief: {
            progress: ["Bound provider task to durable work"],
            open_questions: ["Production hook still pending"],
          },
        });
      }
      throw new Error(`unexpected tool ${body.tool}`);
    };
    const bridge = new WebCodexContinuityBridge(config(), fetchImpl);
    await bridge.bindTask("thread_recover", "Preserve durable state across a model-context loss.");
    const snapshot = await bridge.recoverTask("thread_recover");

    expect(snapshot.binding.goalRevision).toBe(3);
    expect(snapshot.goal).toEqual(goalOutput("wc_goal_eeeeeeeeeeeeeeee", 3));
    expect(snapshot.handoff).toEqual({
      handoff_brief: {
        progress: ["Bound provider task to durable work"],
        open_questions: ["Production hook still pending"],
      },
    });
  });

  test("lost response after an effect is reported as outcome_unknown and is never auto-replayed", async () => {
    let workCalls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { tool: string };
      if (body.tool === "create_goal") return jsonResponse(goalOutput("wc_goal_1111111111111111", 1));
      if (body.tool === "work_on_project") {
        workCalls += 1;
        throw new Error("connection reset");
      }
      throw new Error(`unexpected tool ${body.tool}`);
    };
    const bridge = new WebCodexContinuityBridge(config(), fetchImpl);

    let error: unknown;
    try {
      await bridge.bindTask("thread_uncertain", "Do not duplicate uncertain work.");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WebCodexContinuityError);
    expect((error as WebCodexContinuityError).kind).toBe("outcome_unknown");
    expect(workCalls).toBe(1);
    expect(bridge.getBinding("thread_uncertain")).toBeUndefined();
  });
});
