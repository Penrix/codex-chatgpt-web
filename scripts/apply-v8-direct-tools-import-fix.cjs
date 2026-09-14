const fs = require("node:fs");

const file = "src/adapters/chatgpt-web/index.ts";
const source = fs.readFileSync(file, "utf8");
const before = `import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";`;
const after = `import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";`;
const first = source.indexOf(before);
if (first < 0) throw new Error("V8 direct tools: expected model import was not found");
if (source.indexOf(before, first + before.length) >= 0) throw new Error("V8 direct tools: model import is ambiguous");
const patched = source.slice(0, first) + after + source.slice(first + before.length);
fs.writeFileSync(file, patched);
if (!fs.readFileSync(file, "utf8").includes("CHATGPT_WEB_MODEL_ID")) {
  throw new Error("V8 direct tools: Sol model id import did not persist");
}
process.stdout.write("V8_DIRECT_TOOLS_IMPORT_FIX_APPLIED\n");
