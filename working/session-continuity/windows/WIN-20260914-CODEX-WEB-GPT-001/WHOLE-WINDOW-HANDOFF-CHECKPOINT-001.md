# WHOLE-WINDOW HANDOFF CHECKPOINT 001

- checkpoint_id: `CODEX-WEB-GPT-WIN-20260914-001-HANDOFF-001`
- source_window_event_at: `2026-09-14T06:10:35Z`
- generated_for: `Session Continuation / Whole-Window Blind Transfer`
- repository: `Penrix/codex-chatgpt-web`
- active_branch: `fix/standalone-cli-installer-v6`
- source_code_head_at_handoff: `b97dd95cf1840d88db1f7b3c4e8b98081d83b39e`
- active_pr: `#3 — fix: install Codex Web GPT into standalone Windows CLI`
- active_pr_state: `OPEN / DRAFT / NOT MERGED`
- base_commit: `e85e3693fdb4e3e033348c08df0298c20fcdb612` (upstream v5.0.6 baseline)
- targeted_ci_run: `34805580847`
- v7_installer_sha256: `eaae9c81f4c669b589a04e352928484806c06026a698ae64757ea603b429b730`
- transfer_status: `PARTIAL SUCCESS — standalone CLI + ChatGPT Web High is proven end-to-end on the target Windows machine; interrupt hook / startup injection / local-tool harness / native passthrough / Desktop diagnosis remain open`
- protocol_basis: shared SCP / Whole-Window Handoff semantics. This is a cognitive-state handoff, not a chat recap.

---

# 0. 这个文件要恢复什么

这不是“上一窗口做了哪些提交”的流水账。

代码事实、PR、CI、installer SHA 都在 GitHub。真正需要保存的是这个窗口形成出来的**判断位置**：

- 为什么我们不再把 Codex Desktop 当成当前第一调试对象；
- 为什么 standalone CLI 不是最终产品替代品，而是稳定底座和诊断探针；
- 为什么 CI 通过从来不等于用户机器已修好；
- v1→v7 每一次失败到底改变了什么假设；
- 哪些问题已经被真实机器证伪；
- 哪些问题只是被隔离，而不是解决；
- 下一窗口看到什么现象时，应该先激活哪条区分，而不是重新扩大搜索空间。

仓库 live state 永远高于本文件。如果当前 branch/PR 已前进，先吸收后续提交，但不要因为新的 commit 没复述本文件，就静默丢掉仍然有效的认知。

---

# 1. 当前 Mother Problem 已经改变

最早的问题近似是：

> 如何让 Codex Desktop 的模型选择器出现 `chatgpt-web/*`？

这已经不是当前 Mother Problem。

现在真正的问题是：

> **先保持一个已真实证明可用的 Windows 稳定底座：官方 standalone Codex CLI 0.154.0 + Codex Web GPT V7 + ChatGPT Web High。把 Desktop、native passthrough、interrupt hook、Full MCP 等变量逐层隔离，再用这个底座去诊断 Desktop，而不是继续让 Desktop 自己成为诊断环境。**

更短：

```text
稳定对照组先成立
→ 每个剩余故障单独归层
→ 最后再诊断 Desktop
```

不是：

```text
Desktop 还不对
→ 再改 catalog
→ 再重装
→ 再猜
```

---

# 2. 任务拓扑

```text
Parent Mainline
= 让 Codex Web GPT 在用户 Windows 上长期可用，并最终恢复/诊断 Codex Desktop 使用体验

Current Work Block
= 建立并清理 standalone CLI 稳定底座

Current Task Role
= 诊断基础设施 / 对照组，不是要求用户改用命令行作为最终交互

Insertion Reason
= Desktop 路径连续多轮出现 catalog/picker/migration/restart-state 不确定性；
  用户提出：先把 CLI + Codex Web GPT 做好，再让本地 CLI 去检查 Codex Desktop 为什么出问题

Bounded Deliverable
= 官方 Codex CLI 0.154.0 能通过本地 Bridge 调用 chatgpt-web/high，并真实返回至少一轮回答；
  Launcher 登录 / 浏览器冒烟 / 安装到 Codex 三项均通过

Exit Condition
= 已达成核心 E2E；
  但底座清理尚未完成：Interrupt hook、启动 exe 路径注入、Full MCP、本地 native passthrough 仍需处理

Return Pointer
= 底座清理后，用 standalone CLI 作为健康对照诊断 Codex Desktop；
  不要把“CLI 可用”误读成“Desktop 不再重要”
```

---

# 3. 认知是怎样变成现在这样的

这是本恢复包最重要的部分。

## 3.1 第一阶段：错误地把 Bridge `/models` 当成 Desktop 模型入口

早期思路：

```text
Codex Desktop
→ 请求 Bridge /models
→ Bridge 返回 native + chatgpt-web/*
→ Desktop picker 出现 Web 模型
```

真实机器证据：

- Bridge `/healthz` 的 `successful_model_catalog_requests = 0`
- Desktop 从未向 Bridge 请求模型目录
- 用户机器上 Web 模型仍不出现

因此第一次收缩：

> **Desktop 的模型目录不是从 Bridge `/models` 这一层取得。**

以后再看到“模型不显示”，不得回退到继续增强 `/models` fallback。

## 3.2 第二阶段：官方 `model_catalog_json` 是正确方向，但 CI 不能代替迁移事实

第二版使用 Codex 官方 `model_catalog_json`：

- CI 能把官方 native catalog + Web models 合成；
- official CLI 能读到合并后的模型；
- 但用户真实 `~/.codex/config.toml` 根本没有 `model_catalog_json`。

原因不是 catalog 格式错，而是旧 integration 已经 `active=true`，Launcher 早退：

```text
if (current.active) return current;
```

所以新迁移根本没运行。

认知变化：

> **“协议上可用” != “用户当前安装真的迁移过”。**

从此真实机器配置状态优先于 CI 的“理论可行”。

## 3.3 第三阶段：迁移真正运行后，暴露的是下一层真实不兼容

修掉 early-return 后，迁移终于执行，接着暴露：

1. Desktop bundled CLI 不支持当时假定的 `debug models --bundled`
2. Windows Electron 的 ChatGPT hard refresh 路径失败

因此 v4 改为：

- isolated temp `CODEX_HOME` + plain `debug models`
- browser 先回 idle document，再 fresh navigate ChatGPT temporary chat
- 保持严格 auth check，不放松认证

认知变化：

> **一个更深层失败只有在上一层真的跑起来后才会出现。不要把新错误当成“前一个判断完全错了”。**

## 3.4 第四阶段：v4/v5 的“重新安装”循环暴露状态模型错误

v4/v5 即使修了上述问题，Launcher 仍可能：

```text
coreSetupComplete = true
codexCatalogVerified = false
```

UI 因而持续给用户“重新安装”。

用户明确反感“安装→观察→重建”的无尽循环，并要求：

- 详细日志；
- 自动检测；
- 不要每次让用户手工跑 PowerShell；
- 如果当前路走不通，换稳定思路。

因此策略改变为 diagnostics-first：

> **安装成功必须是事务性的：安装后立即重读真实状态；失败就明确失败/回滚，不允许半成功 UI。**

同时形成一条持续 Guard：

> **以后不要让用户充当日志系统。程序自己收集证据。**

## 3.5 第五阶段：为什么转向 standalone CLI

用户提出关键方向：

> 能不能先把 CLI + Codex Web GPT 弄好，再让本地 CLI 去检查 Codex Desktop 为什么出问题？

这不是“放弃 Desktop”。

真正的价值是建立**健康对照组**：

```text
Standalone CLI
= 我们可控、可直接指定模型、可直接看 debug models、没有 Desktop UI/picker/Electron 层

Desktop
= 被诊断对象
```

于是推理方式从：

```text
Desktop 自己诊断 Desktop
```

变成：

```text
健康 CLI 对照组
VS
Desktop bundled CLI / app-server / UI
```

这一步是当前整个工作的认知转轴。

## 3.6 第六阶段：0.152.1 是稳定候选，但用户真实环境最终以 0.154.0 为事实锚

网络反馈粗筛时，0.152.1 的已报告 bug 相对少，因此最初把：

```text
Codex CLI 0.152.1 + upstream Web GPT v5.0.6
```

定为稳定候选。

PR #2 在 Windows Actions 中实际证明：

```text
official Codex CLI 0.152.1
→ native catalog
→ augment chatgpt-web/*
→ same CLI reads augmented catalog
→ NATIVE_CODEX_CATALOG_SMOKE_OK
```

但用户实际已经安装 standalone `0.154.0`，并且它原生模式可以正常回答。

因此后续不再要求用户降级，而是：

> **用 0.152.1 证明上游 catalog 契约，再用用户真实的 0.154.0 做实际底座验收。**

不要在新窗口里擅自又要求降回 0.152.1，除非出现新的 0.154.0 版本级证据。

## 3.7 第七阶段：V6 第一次真正安装失败，根因不是 CLI 不兼容

V6 在用户机器初始页直接报：

```text
Codex bridge route is inconsistent:
Codex openai_base_url changed after setup...
```

第三项“安装到 Codex”又报：

```text
managed Windows model catalog is not active
```

源码复盘得到两个确定 bug：

### A. stale journal 被当成致命篡改

用户此前为恢复原生 CLI 改过/删过 `openai_base_url`。
旧 journal 仍认为 bridge 在接管。

V6 启动时：

```text
old journal != current config
→ 认为用户新值不能覆盖
→ restore previous route
→ restore 又走同一个严格检查
→ 双重同文报错
```

正确认知：

> **显式 `--replace-codex-route` 时，这是一种可修复 stale state，不应永久卡死。**

### B. `staticCatalogActive` 实际算出来了，但 status JSON 漏传字段

底层 integration 已经知道 `staticCatalogActive`。

但 `route status` 输出里漏了它。

Launcher 安装后又检查：

```text
route.staticCatalogActive === true
```

于是实际得到 `undefined`，必然自判失败。

这意味着：

> **V6 的“catalog inactive”不能作为 catalog 真没安装的证据。**

## 3.8 第八阶段：V7 修复后，真实机器三项全绿

V7 修复：

- stale journal repair path；
- `route status` 暴露 `staticCatalogActive`；
- Windows regression：
  - install
  - 确认 `staticCatalogActive=true`
  - 人为删除 `openai_base_url` 模拟 V6 残留
  - reinstall with replace
  - 必须恢复 `active=true`, `staticCatalogActive=true`, `errors=[]`
- exact official Codex CLI 0.154.0 package validation
- standalone path priority

CI target job 已通过：
- 0.154.0 checksum
- `NATIVE_CODEX_CATALOG_SMOKE_OK`
- standalone discovery
- `V7_ROUTE_STATUS_AND_STALE_JOURNAL_REPAIR_OK`
- TypeScript check
- NSIS installer build
- SHA artifact

然后用户真实机器：

```text
登录 ChatGPT          ✅
浏览器冒烟测试         ✅
安装到 Codex          ✅
```

这里第一次可以确认：

> **安装状态链已经真正成立。**

## 3.9 第九阶段：原生模型 502 不等于 Web High 失败

用户启动 CLI 时底部仍是：

```text
gpt-5.6-sol medium
```

请求返回：

```text
502 Bad Gateway
The socket connection was closed unexpectedly
http://127.0.0.1:17841/v1/responses
```

这条请求走的是：

```text
native gpt-5.6-sol
→ Bridge native passthrough
```

不是 Web High。

因此形成关键区分：

```text
native passthrough failure
!=
chatgpt-web/high failure
```

这个 502 仍未解决，但不能再拿它否定 Web 路径。

## 3.10 第十阶段：第一次切 High 的长 Working 也不能立刻判 Web 路径失败

切换后出现：

```text
Model changed to chatgpt-web/high high
Working ...
Messages to be submitted after next tool call
↳ 回复ok
```

当时旧 turn 尚在运行，“回复ok”只是 queued steer。

所以不能把长 Working 直接当作 Web High 失败。

之后用户 Esc/steer，出现：

```text
Hook failed
hook exited with code 1

Model interrupted to submit steer instructions.
```

随后真正 Web 请求显示 adapter 自己的：

```text
Local tools unavailable
ChatGPT Web High cannot access the local Codex computer in this turn.
```

这证明已经进入 Web adapter 路径。

最后真实返回：

```text
• ok
```

第二轮：

```text
用户：你是谁？
• 我是 Codex，你这边的 OpenAI 编程与协作助手。
```

底部仍为：

```text
chatgpt-web/high high
```

因此当前最重要事实已经成立：

> **官方 standalone Codex CLI 0.154.0 + Codex Web GPT V7 + ChatGPT Web High 已在目标 Windows 机器完成真实端到端回答，而且连续第二轮也成立。**

不是 catalog smoke，不是 UI 绿勾，而是真回答。

---

# 4. 当前已经成立的 WHAT

## 4.1 稳定底座核心 E2E：PROVEN

```text
Codex CLI 0.154.0
→ chatgpt-web/high
→ 127.0.0.1:17841 /v1/responses
→ Codex Web GPT Bridge
→ 内置 ChatGPT 浏览器
→ ChatGPT Web High
→ 返回 Codex CLI
```

真实机器已返回 `ok`，并完成第二轮回答。

## 4.2 Launcher 三个主 setup gate：PROVEN ON TARGET MACHINE

- ChatGPT login：绿勾
- browser smoke：绿勾
- Install to Codex：绿勾

## 4.3 模型 catalog / standalone discovery：PROVEN

- PR #2：official CLI 0.152.1 contract pass
- PR #3：official CLI 0.154.0 contract + installer pass
- 用户机器可切到 `chatgpt-web/high high`

## 4.4 Desktop：NOT SOLVED / NOT ABANDONED

CLI 是稳定底座和诊断探针，不是最终宣布 Desktop 不做了。

---

# 5. 当前还没闭合的裂缝

## 5.1 Interrupt hook：OPEN / HIGH PRIORITY

真实现象：

```text
• Hook failed
  └ hook exited with code 1
```

触发场景出现在模型切换/中断旧 turn/steer 周边。

当前已知：

- Web High 普通 turn 可以完成；
- 所以 hook failure 不是主链必死；
- 但它可能导致 interrupt / steering / cleanup 不可靠；
- managed hook 安装逻辑在 `src/codex-interrupt-hook.ts`；
- 现在需要查 hook runtime command 的 exit-1 根因，而不是重新查 catalog。

禁止误读：

```text
Hook failed
!=
Web High 没接通
```

## 5.2 Codex 启动时自动出现 exe 路径：OPEN

用户多次启动后出现：

```text
C:\Users\123\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe
```

重要纠正：

> **这不是用户输入的。**

旧窗口曾错误把它解释成用户把路径输入到 Codex；用户已明确纠正。

所以新窗口不得再次说“不要输入那个 exe 路径”。

需要查：

- Launcher/shortcut invocation
- standalone install/start arguments
- session restore / initial prompt
- executable path 是否被错误当作 positional prompt

## 5.3 Full MCP / local tools：EXPECTED MISSING, NOT A MODEL BUG

Web High 回答前会显示：

```text
Local tools unavailable
ChatGPT Web High cannot access the local Codex computer in this turn.
Action: Open MCP in Codex Web GPT and connect the Full harness...
```

这不是 Web route failure。

当前 Browser-only / Web chat 已经工作，但还没有 Full harness 给 Web model 本地 workspace/tools。

下一阶段需要把 Full MCP 接通，才适合让 Web High 做真正本地诊断工作。

## 5.4 Native model passthrough：OPEN / SEPARATE

`gpt-5.6-sol` 经 Bridge 时曾：

```text
502 Bad Gateway
socket connection was closed unexpectedly
```

这是 native passthrough 共存问题。

它不应阻塞 Web High 稳定底座判定。

未来如果希望“原生模型 + Web 模型共存且都能走同一个 route”，再修 `src/native-passthrough.ts` / auth / transport。

## 5.5 CLI 启动 25 issues：BOUNDED UNKNOWN

CLI 启动显示：

```text
⚠ 25 startup issues
```

尚未逐项查看。

同时有：

```text
Under-development features enabled: respect_system_proxy
```

目前没有证据说明它阻塞 Web High。

不要在没有证据时把 25 issues 当总根因。

## 5.6 Desktop diagnosis：DEFERRED UNTIL BASE CLEAN

Desktop 原问题仍在：

- model picker / catalog / app-server / bundled CLI / frontend filtering 哪一层出错尚未最终归因；
- 之前公开 issue 有“CLI/app-server 有模型但 Desktop picker 不显示”的近邻；
- 但当前先不碰。

---

# 6. 当前 Active Cognitive Neighborhood

新窗口碰到下列现象时，应该自动先激活这些区分：

```text
Launcher 三项全绿 + Web High 真回答
→ 安装链已证明
→ 不准又从 catalog/重装开始

gpt-5.6-sol 502
→ 先判断是不是 native passthrough
→ 不准直接宣布 Web High 失败

chatgpt-web/high 出现 Local tools unavailable
→ 这是 Full MCP 未连接
→ 不准当模型路由错误

Hook failed code 1
→ 看 interrupt lifecycle hook
→ 不准回头改 static catalog

Codex 启动出现 codex.exe 路径
→ 这是自动注入候选 bug
→ 不准说是用户输入

CI 绿但用户机器失败
→ 用户机器事实优先
→ CI 只说明某层契约成立

新错误只在上一层修好后出现
→ 说明搜索空间收窄
→ 不准把新错误自动解释成“整个方向错了”

Desktop 仍不显示模型
→ 用 standalone CLI 作为健康对照
→ 比较 CLI catalog / app-server / Desktop UI
→ 不准再让 Desktop 自己成为唯一诊断环境
```

---

# 7. 当前最危险的旧路径 / Generic Priors

1. 一看到问题就继续“重新安装”。
2. 把 catalog、route、Web adapter、native passthrough、MCP、Desktop picker 混成一个“Codex 不工作”。
3. 把 CI pass 当作用户机器 pass。
4. 再让用户执行长 PowerShell 诊断脚本，而不是把诊断集成进 Launcher。
5. 因 0.152.1 理论更稳就擅自让用户降级已经真实跑通的 0.154.0。
6. Web High 已真实回答后还把底座状态说成“尚未验证”。
7. 因 Hook failed 就推翻 V7 安装链。
8. 忘记用户最终仍偏好 Desktop，误把 CLI-first 变成“以后只用命令行”。
9. 再次把自动出现的 exe 路径归因给用户手工输入。

---

# 8. 当前工程锚点

## Repository

`Penrix/codex-chatgpt-web`

## Active branch

`fix/standalone-cli-installer-v6`

## PR #3

`fix: install Codex Web GPT into standalone Windows CLI`

状态：

```text
OPEN
DRAFT
NOT MERGED
```

source head at handoff：

`b97dd95cf1840d88db1f7b3c4e8b98081d83b39e`

base：

`e85e3693fdb4e3e033348c08df0298c20fcdb612`

## PR #2

`test: prove official standalone Codex CLI integration`

作用：

> 干净证明 upstream v5.0.6 catalog layer 与 official standalone CLI 0.152.1 兼容。

不要把它当当前运行分支。

## PR #1

legacy Desktop static-catalog experiment。

只在需要回看旧失败链时读取。

不得直接合并。

## V7 target CI

run：

`34805580847`

已通过目标 Windows installer job。

V7 installer SHA-256：

`eaae9c81f4c669b589a04e352928484806c06026a698ae64757ea603b429b730`

---

# 9. 下一合法方向

**注意：以下是恢复完成后的候选下一动作，不允许绕过恢复验收直接重型开工。**

优先顺序：

```text
1. 修 Hook failed / interrupt lifecycle
2. 查 codex.exe 路径为什么自动进入会话
3. 接通 Full MCP harness，让 Web High 能看到本地工具/工作区
4. 修 native model passthrough 502（如果仍需要原生模型共存）
5. 用稳定 CLI 作为对照组正式诊断 Codex Desktop
```

Desktop 诊断时的分层目标：

```text
catalog 没加载
→ CLI/config 层

catalog 有，但 app-server model/list 没有
→ backend/app-server 层

app-server model/list 有，但 Desktop picker 没有
→ Desktop frontend/filtering 层
```

---

# 10. Recovery Validation Gate

新窗口先恢复，不自动开工。

最低验收：

新窗口应能闭卷用自己的话回答：

1. 为什么我们从 Desktop-first 转成 CLI-first？
2. CLI-first 为什么不是“放弃 Desktop”？
3. V7 最终证明了什么，而且证明的证据为什么比三个绿勾更强？
4. `gpt-5.6-sol` 的 502 为什么不能否定 `chatgpt-web/high`？
5. `Local tools unavailable` 为什么不是模型失败？
6. `Hook failed` 当前应该落在哪一层？
7. 那个 `codex.exe` 路径是谁输入的？
8. 当前下一步为什么不是继续改 catalog？

正确恢复的核心表达应接近：

> 我们已经有一个真实机器上跑通的健康对照组：standalone Codex CLI 0.154.0 + V7 + Web High。此前 Desktop 路径的多轮失败说明不能再把 catalog、UI picker、Bridge 和运行时混成一个问题。现在应先清理这个底座的 interrupt hook、启动参数注入和 Full MCP，再用它对照 Desktop；Web High 已经实答，所以不准回到“重新安装/重新证明 catalog”的旧循环。

如果新窗口说不出这条因果链，只能复述“V7 成功”，恢复不合格。

---

# 11. Recovery Failure Conditions

出现以下任一项，说明认知没有接上：

- 又让用户安装 V7 来证明 Web High 是否可用；
- 又从 `/models` fallback 开始修 Desktop；
- 把 `Local tools unavailable` 当 Web route failure；
- 把 native `gpt-5.6-sol` 502 当 Web High 502；
- 再说 exe 路径是用户输入的；
- 直接建议降级到 0.152.1；
- 忘记 PR #3 仍是 Draft；
- 认为 Desktop 已经解决；
- 认为 Desktop 已经被放弃；
- 看到 Hook failed 就重做 catalog；
- 让用户继续充当人工日志系统。

出现任一项，应重新读本 Handoff + Manifest + 当前 repo live state。

---

# 12. Recovery Completion Condition

当新窗口：

- repo / PR / CI 状态与当前 live state 对齐；
- 能准确复述上面的认知转轴；
- 能区分 Web route / native passthrough / interrupt hook / Full MCP / Desktop UI；
- 不会重新打开已经被证伪的旧搜索空间；
- 下一动作自然落到 hook / startup injection / MCP，而不是 catalog 重装；

即可视为恢复完成。
