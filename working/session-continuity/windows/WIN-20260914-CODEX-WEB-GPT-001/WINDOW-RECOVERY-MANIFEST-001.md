# WINDOW RECOVERY MANIFEST 001

- manifest_id: `CODEX-WEB-GPT-WIN-20260914-001-RECOVERY-001`
- source_window: `WIN-20260914-CODEX-WEB-GPT-001`
- repository: `Penrix/codex-chatgpt-web`
- active_branch_at_handoff: `fix/standalone-cli-installer-v6`
- source_code_anchor: `b97dd95cf1840d88db1f7b3c4e8b98081d83b39e`
- active_pr: `#3`
- targeted_ci_run: `34805580847`
- recovery_mode: `continuation-capable / whole-window cognitive transfer with repo validation`
- protocol_source: `Penrix/male-webnovel-cognition/.hermes/skills/mwne-session-continuation/SKILL.md`
- handoff: `WHOLE-WINDOW-HANDOFF-CHECKPOINT-001.md`

---

## 1. 恢复目标

恢复上一窗口已经形成的 Codex Web GPT 判断位置，而不是重新介绍项目。

成功恢复以后，新窗口必须立即知道：

1. 当前为什么以 standalone CLI 为稳定底座；
2. 为什么这不是放弃 Codex Desktop；
3. V7 已经在哪些层级真实通过；
4. Web High 真实 E2E 已经成立；
5. 当前剩余问题分别属于哪一层；
6. 下一步为什么是 Hook / startup injection / MCP，而不是 catalog / reinstall。

---

## 2. 强制读取顺序

### 第一层：恢复脑子

1. `working/session-continuity/windows/WIN-20260914-CODEX-WEB-GPT-001/WINDOW-RECOVERY-MANIFEST-001.md`
2. `working/session-continuity/windows/WIN-20260914-CODEX-WEB-GPT-001/WHOLE-WINDOW-HANDOFF-CHECKPOINT-001.md`

### 第二层：核对当前 live branch / PR

3. PR `#3 — fix: install Codex Web GPT into standalone Windows CLI`
4. 当前 `fix/standalone-cli-installer-v6` HEAD
5. 若 HEAD 晚于 `b97dd95...`，比较后续 commits；repo live state 优先

### 第三层：当前最相关实现

6. `src/codex-interrupt-hook.ts`
7. `src/server.ts`
8. `src/native-passthrough.ts`
9. `src/codex-integration.ts`
10. `src/codex-static-catalog-route.ts`
11. `launcher/electron/runtime.cjs`
12. `launcher/electron/main.cjs`

### 第四层：必要时回看形成过程

13. PR #2 — standalone CLI 0.152.1 catalog contract proof
14. PR #1 — legacy Desktop static-catalog experiment，仅作历史参考
15. Windows CI run `34805580847`

不要无差别重读整个仓库。先恢复当前因果链。

---

## 3. 协议语义

沿用用户已有 SCP / Whole-Window Handoff：

- Handoff 保存 live cognitive state，不是聊天摘要；
- Manifest 负责恢复路由、验真、补洞；
- unresolved 必须保存为 bounded unknown；
- repo live state 高于交接文本；
- 状态同步 != 认知恢复；
- 新窗口必须恢复“为什么现在这样判断”，而不只是最终结论。

当前窗口最重要的认知运动：

```text
Desktop-first
→ 多轮 catalog/picker/migration/restart-state 失败
→ 发现 Desktop 同时包含太多不可控层
→ standalone CLI 成为健康对照
→ exact official 0.154.0 + V7 真实 Web High 回答
→ 稳定底座成立
→ 剩余故障逐层隔离
→ 最后再诊断 Desktop
```

---

## 4. Repo / PR / CI 验真锚点

### Base

`e85e3693fdb4e3e033348c08df0298c20fcdb612`

### Source code anchor

`b97dd95cf1840d88db1f7b3c4e8b98081d83b39e`

### Active PR

#3 — Draft / Open / Not merged

### Target CI

run `34805580847`

通过的目标链包括：

- exact official Codex CLI 0.154.0 checksum
- `NATIVE_CODEX_CATALOG_SMOKE_OK`
- standalone discovery/static catalog
- `V7_ROUTE_STATUS_AND_STALE_JOURNAL_REPAIR_OK`
- TypeScript check
- NSIS installer build
- artifact upload

### Installer

SHA-256:

`eaae9c81f4c669b589a04e352928484806c06026a698ae64757ea603b429b730`

### Target-machine evidence, higher value than CI

用户真实机器已经：

```text
登录 ChatGPT      ✅
浏览器冒烟测试     ✅
安装到 Codex      ✅
Model changed to chatgpt-web/high high
回复ok             → ok
你是谁？           → 我是 Codex，你这边的 OpenAI 编程与协作助手。
```

因此 real Web High E2E 已证明。

---

## 5. 当前最小充分 FCC

### Mother Problem

不是：

> 继续证明 `chatgpt-web/high` 有没有安装。

也不是：

> 继续让 Desktop picker 显示模型。

当前真正问题：

> **保持已经成立的 CLI + V7 + Web High 稳定底座，修掉 interrupt/startup/MCP 等局部裂缝；然后用该健康对照组诊断 Desktop 到底坏在 catalog、app-server 还是 UI。**

### 当前最危险模型先验

- “又出错 = 整体路线又错了”
- “502 = 所有模型都坏了”
- “Local tools unavailable = Web High 失败”
- “Hook failed = catalog 没装好”
- “CLI-first = 以后让用户学命令行”
- “0.152.1 bug 少 = 必须降级”
- “CI 绿 = 用户机器一定绿”
- “exe path 出现在窗口 = 用户手输的”

---

## 6. Bounded Unknowns

| 项目 | 已知约束 | 仍未知 | 禁止回退 |
|---|---|---|---|
| Interrupt hook | Web High 普通 turn 可完成；切模型/steer 周边出现 `hook exited with code 1` | runtime hook 为什么 exit 1；是否是 args/auth/lifecycle/timeout | 不准重做 catalog |
| exe path 自动注入 | 多次 Codex 启动后自动出现 standalone `codex.exe` 路径；用户明确没输入 | shortcut / invocation / session restore / positional arg 哪一层造成 | 不准归因用户误操作 |
| Full MCP | Web High 已能聊天；明确提示 local tools unavailable | Full harness 连接后本地工具 contract 是否完整 | 不准把提示当 Web 模型故障 |
| native passthrough | `gpt-5.6-sol` 经 Bridge 返回 502 | auth / upstream transport / socket teardown 具体根因 | 不准拿它否定 Web High |
| 25 startup issues | CLI 启动有 25 issues，但 Web High 已完成两轮 | 每项具体是什么 | 不准无证据当总根因 |
| Desktop | 原模型 picker 问题尚未最终归因 | catalog / app-server / frontend filtering 具体层 | 不准回到 blind reinstall |
| 0.152.1 vs 0.154.0 | 0.152.1 catalog proof；0.154.0 target machine real E2E | 长期版本策略 | 不准无新证据强制降级 |

---

## 7. 第一轮恢复验收

新窗口不要直接写代码。

先核：

1. PR #3 当前 head / state 是否变了；
2. `b97dd95...` 之后有哪些代码提交；
3. run `34805580847` 之后是否有新 Windows CI；
4. `src/codex-interrupt-hook.ts` 当前是否仍是 managed Interrupt command hook；
5. `src/server.ts` Web route / native passthrough 分流是否仍然存在；
6. 当前用户目标是否仍是“先清理稳定底座，再诊断 Desktop”。

然后闭卷回答：

- 为什么 CLI-first？
- Web High 证明到什么程度？
- 为什么 native 502 不影响 Web route 结论？
- Hook failed 属于哪一层？
- exe path 是不是用户输入？
- 下一合法动作是什么？

通过后再继续工作。

---

## 8. 当前任务 routing

若用户没有改变目标：

### Priority 1

修 `Hook failed / hook exited with code 1`。

### Priority 2

定位 Codex 启动时 standalone `codex.exe` 路径为什么自动进入会话。

### Priority 3

连接 Full MCP harness，让 Web High 获得本地工具能力。

### Priority 4

如果需要原生/Web 模型共存，修 native passthrough 502。

### Priority 5

开始正式 Desktop 分层诊断：

```text
CLI catalog
→ app-server model/list
→ Desktop picker
```

---

## 9. Recovery Failure Conditions

新窗口若出现以下任一行为，应停止并重读 Handoff：

- 再要求用户安装/重装 V7 来验证 Web High；
- 再从 Bridge `/models` 开始；
- 把 Hook failed 当 catalog 失败；
- 把 Local tools unavailable 当模型失败；
- 把 exe path 说成用户输入；
- 直接要求降 0.152.1；
- 忘记 Desktop 仍是未来目标；
- 忘记 Web High 已真实完成两轮；
- 不区分 native passthrough 与 Web route；
- 又让用户跑大段手工诊断脚本。

---

## 10. Recovery Completion Condition

新窗口应自然站在这个位置：

> standalone CLI 0.154.0 + V7 + Web High 已经是现实成立的健康对照组。现在不是继续证明模型能不能装，而是把 interrupt/startup/MCP 局部裂缝清干净，再拿这个对照组去定位 Desktop 的具体故障层。

且 repo/PR/CI 核查与当前 live state 一致，即恢复完成。
