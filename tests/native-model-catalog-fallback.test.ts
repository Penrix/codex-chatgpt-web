import { expect, test } from "bun:test";
import { forwardNativeCodexRequest } from "../src/native-passthrough";

const bundledCatalog = {
  models: [{
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    visibility: "list",
    supported_in_api: true,
    supported_reasoning_levels: [],
    tool_mode: "code_mode_only",
  }],
};

test("unauthenticated Codex /models route probes return 401 instead of bridge 502", async () => {
  let upstreamCalled = false;
  const response = await forwardNativeCodexRequest(
    new Request("http://127.0.0.1:17841/v1/models"),
    "models",
    async () => {
      upstreamCalled = true;
      return Response.json({ models: [] });
    },
  );

  expect(response.status).toBe(401);
  expect(upstreamCalled).toBe(false);
  expect(await response.json()).toMatchObject({
    error: { type: "authentication_error", code: "missing_authorization" },
  });
});

test("Windows bundled catalog fallback recovers transport failures without freezing config", async () => {
  const response = await forwardNativeCodexRequest(
    new Request("http://127.0.0.1:17841/v1/models?client_version=0.153.4", {
      headers: { authorization: "Bearer codex-oauth-token" },
    }),
    "models",
    async () => { throw new Error("simulated transport failure"); },
    undefined,
    () => bundledCatalog,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("x-codex-chatgpt-web-catalog-source")).toBe("windows-bundled-fallback");
  expect(await response.json()).toEqual(bundledCatalog);
});

test("Windows bundled catalog fallback recovers upstream 5xx model discovery", async () => {
  const response = await forwardNativeCodexRequest(
    new Request("http://127.0.0.1:17841/v1/models?client_version=0.153.4", {
      headers: { authorization: "Bearer codex-oauth-token" },
    }),
    "models",
    async () => new Response("temporarily unavailable", { status: 503 }),
    undefined,
    async () => bundledCatalog,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("x-codex-chatgpt-web-catalog-source")).toBe("windows-bundled-fallback");
  expect(await response.json()).toEqual(bundledCatalog);
});

test("catalog fallback never masks an authenticated 401 from the official backend", async () => {
  let fallbackCalled = false;
  const response = await forwardNativeCodexRequest(
    new Request("http://127.0.0.1:17841/v1/models?client_version=0.153.4", {
      headers: { authorization: "Bearer expired-token" },
    }),
    "models",
    async () => Response.json({ error: { message: "unauthorized" } }, { status: 401 }),
    undefined,
    () => {
      fallbackCalled = true;
      return bundledCatalog;
    },
  );

  expect(response.status).toBe(401);
  expect(fallbackCalled).toBe(false);
});
