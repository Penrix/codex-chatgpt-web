import type { AppConfig } from "./config";
import type { CodexModelContextOverride } from "./codex-integration";
import {
  availableChatGptWebModelRoutes,
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  CHATGPT_WEB_MODEL_PREFIX,
  resolveChatGptWebContextLimits,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function slug(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as JsonObject).slug;
  return typeof candidate === "string" ? candidate : undefined;
}

function reasoningLevel(template: JsonObject, effort: string, description: string): JsonObject {
  const levels = Array.isArray(template.supported_reasoning_levels)
    ? template.supported_reasoning_levels.filter(level => level && typeof level === "object" && !Array.isArray(level)) as JsonObject[]
    : [];
  const source = levels.find(level => level.effort === effort);
  return { ...(source ? structuredClone(source) : {}), effort, description };
}

function modelPriority(template: JsonObject): number | undefined {
  const value = template.priority;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Native Codex model template priority must be an integer");
  }
  return value;
}

function routedModelPriority(
  template: JsonObject,
  route: ChatGptWebModelRoute,
  config: AppConfig,
): number | undefined {
  const priority = modelPriority(template);
  if (priority === undefined
    || config.subagentProtocol !== "compatibility-v1"
    || route.slug !== "chatgpt-web/light") return priority;
  if (priority === Number.MAX_SAFE_INTEGER) {
    throw new Error("Native Codex model template priority cannot reserve the Compatibility V1 roster");
  }
  // Codex V1 exposes at most five model overrides. Keep the native Sol row plus the four useful
  // delegated Web efforts (Medium, High, Extra High, Pro); Instant remains a selectable root model
  // but does not displace Pro from spawn_agent's bounded registry.
  return priority + 1;
}

function nativeTemplateCandidate(
  value: unknown,
  requireTools: boolean,
  requireListVisibility: boolean,
): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as JsonObject;
  const modelSlug = slug(model);
  if (!modelSlug || modelSlug.startsWith(CHATGPT_WEB_MODEL_PREFIX)) return false;
  // Exact routed backends may be hidden from Codex's ordinary picker (Luna is one such row) while
  // still carrying the authoritative instructions and tool metadata for that backend. Visibility is
  // therefore a fallback-selection rule, not a prerequisite for an exact backend template.
  if (requireListVisibility && model.visibility !== "list") return false;
  if (!Array.isArray(model.supported_reasoning_levels)) return false;
  return !requireTools || (typeof model.tool_mode === "string" && model.tool_mode.length > 0);
}

function preferredNativeTemplateSlug(route: ChatGptWebModelRoute): string {
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) return CHATGPT_WEB_LUNA_BACKEND_MODEL;
  // Automatic Sol routes and Manual / Zero Risk both use Sol as the native Codex harness model.
  // Zero Risk chooses the visible ChatGPT model manually, so its internal backend id has no native
  // catalog row of its own.
  return CHATGPT_WEB_BACKEND_MODEL;
}

function routeRequiresToolCapableTemplate(route: ChatGptWebModelRoute, config: AppConfig): boolean {
  // Automatic Sol hands browser-selected calls back to native Codex. Preserve the official Sol
  // CodeModeOnly surface even in browser-only mode. Full mode also needs a tool-capable fallback for
  // the explicit Manual / Zero Risk connector path.
  return (route.interactionMode === "automatic" && route.backendModel === CHATGPT_WEB_BACKEND_MODEL)
    || config.mode === "full";
}

function selectNativeTemplate(
  models: unknown[],
  route: ChatGptWebModelRoute,
  config: AppConfig,
): JsonObject {
  const requireTools = routeRequiresToolCapableTemplate(route, config);
  const preferredSlug = preferredNativeTemplateSlug(route);
  const exact = models.find(model => (
    slug(model) === preferredSlug
    && nativeTemplateCandidate(model, requireTools, /*requireListVisibility*/ false)
  )) as JsonObject | undefined;
  if (exact) return exact;

  // Smaller or older Codex catalogs may not contain the preferred backend. Preserve the previous
  // compatibility behavior only as an explicit fallback: choose the first list-visible compatible
  // native model rather than silently treating catalog order as the primary semantic mapping.
  const fallback = models.find(model => (
    nativeTemplateCandidate(model, requireTools, /*requireListVisibility*/ true)
  )) as JsonObject | undefined;
  if (fallback) return fallback;

  throw new Error(
    requireTools
      ? `Native Codex models response has no ${preferredSlug} row and no list-visible, tool-capable fallback with reasoning metadata`
      : `Native Codex models response has no ${preferredSlug} row and no list-visible fallback with reasoning metadata`,
  );
}

function useCompatibilityV1SubagentSurface(model: JsonObject): void {
  // Compatibility V1 is an explicit whole-task protocol mode. Preserve an explicit disabled
  // capability instead of advertising support that the native model denied.
  if (model.multi_agent_version !== "disabled") model.multi_agent_version = "v1";
}

function routedSubagentVersion(template: JsonObject, config: AppConfig): string | undefined {
  if (config.subagentProtocol === "compatibility-v1") return "v1";
  return typeof template.multi_agent_version === "string" ? template.multi_agent_version : undefined;
}

function routedToolMode(
  template: JsonObject,
  route: ChatGptWebModelRoute,
): string | null {
  if (route.interactionMode !== "automatic" || route.backendModel !== CHATGPT_WEB_BACKEND_MODEL) {
    // Luna keeps its existing checkpoint/read-only behavior, and Manual / Zero Risk keeps the
    // explicit connector protocol. Only Automatic Sol currently owns the direct Responses loop.
    return null;
  }
  const mode = template.tool_mode;
  if (typeof mode !== "string" || mode.length === 0) {
    throw new Error("Automatic Sol Web route requires a native Codex tool_mode");
  }
  return mode;
}

export function buildChatGptWebModel(
  templateValue: unknown,
  route: ChatGptWebModelRoute,
  config: AppConfig,
): JsonObject {
  const template = object(templateValue, "native Codex model template");
  const templateSlug = slug(template);
  if (!templateSlug || templateSlug.startsWith(CHATGPT_WEB_MODEL_PREFIX)) {
    throw new Error("ChatGPT Web model template must be a native Codex model");
  }
  const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config);
  const multiAgentVersion = routedSubagentVersion(template, config);
  const priority = routedModelPriority(template, route, config);
  const model: JsonObject = {
    ...structuredClone(template),
    slug: route.slug,
    display_name: route.displayName,
    description: route.description,
    input_modalities: route.interactionMode === "manual" ? ["text"] : ["text", "image"],
    visibility: "list",
    // These slugs are implemented by this local Responses-compatible bridge. Marking them false
    // makes Codex drop them from spawn_agent whenever openai_base_url points at the bridge.
    supported_in_api: true,
    // Follow the official template's ordering without outranking it. Codex advertises at most five
    // spawn-agent overrides; forcing every routed row to priority 0 displaced gpt-5.6-sol from that
    // registry and made an explicit native child model fail validation.
    ...(priority === undefined ? {} : { priority }),
    // In native mode the routed row follows the exact backend template's protocol surface. Web-origin
    // V2 collaboration calls carry the protocol's explicit plaintext marker; Compatibility V1
    // instead pins the entire catalog and Codex feature override to V1.
    ...(multiAgentVersion === undefined
      ? {}
      : { multi_agent_version: multiAgentVersion }),
    // Automatic Sol must keep the official CodeModeOnly surface. It is the native Codex planner
    // that reduces shell/files/MCP/plugins to exec/wait + direct-only tools while preserving the
    // real sandbox and approval dispatcher. Other routes retain their existing transport contract.
    tool_mode: routedToolMode(template, route),
    upgrade: null,
    default_reasoning_level: route.codexEffort,
    supported_reasoning_levels: [reasoningLevel(template, route.codexEffort, route.displayName)],
    context_window: limits.contextWindow,
    max_context_window: limits.contextWindow,
    effective_context_window_percent: limits.effectiveContextWindowPercent,
    auto_compact_token_limit: limits.autoCompactTokenLimit,
    // ChatGPT Web has no Codex service tier. Never inherit the native template's Fast tiers.
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  // A native template's compaction hash describes OpenAI's native model contract, not this routed
  // browser model. The explicit Web window above is owned by this adapter and never copied back to
  // native models or the user's top-level model_context_window setting.
  delete model.comp_hash;
  delete model.availability_nux;
  return model;
}

export function augmentNativeModelCatalog(
  value: unknown,
  config: AppConfig,
  contextOverride?: CodexModelContextOverride,
): JsonObject {
  const catalog = object(value, "native Codex models response");
  if (!Array.isArray(catalog.models)) {
    throw new Error("Native Codex models response is missing a models array");
  }
  const nativeModels = structuredClone(
    catalog.models.filter(model => !slug(model)?.startsWith(CHATGPT_WEB_MODEL_PREFIX)),
  );
  if (config.subagentProtocol === "compatibility-v1") {
    for (const candidate of nativeModels) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        useCompatibilityV1SubagentSurface(candidate as JsonObject);
      }
    }
  }
  if (contextOverride) {
    // model_context_window is a single top-level Codex setting, not a per-model one. Apply its
    // advertised maximum to every native row so switching native models cannot silently clamp the
    // effective override. Codex itself applies context_window and auto-compaction configuration.
    for (const candidate of nativeModels) {
      const modelSlug = slug(candidate);
      if (!modelSlug) continue;
      const model = object(candidate, `native ${modelSlug} model`);
      const current = model.max_context_window;
      if (current !== undefined && current !== null
        && (typeof current !== "number" || !Number.isSafeInteger(current) || current <= 0)) {
        throw new Error(`Native ${modelSlug} max_context_window must be a positive integer`);
      }
      if (current === undefined || current === null || current < contextOverride.contextWindow) {
        model.max_context_window = contextOverride.contextWindow;
      }
    }
  }
  const webModels = availableChatGptWebModelRoutes(config)
    .map(route => buildChatGptWebModel(selectNativeTemplate(nativeModels, route, config), route, config));
  return {
    ...structuredClone(catalog),
    models: [...nativeModels, ...webModels],
  };
}
