# 新窗口启动指令

不要 Fresh Onboarding，不要重讲项目历史，也不要先改代码。

请先恢复上一窗口的 Whole-Window Cognitive State。

仓库：`Penrix/codex-chatgpt-web`
当前恢复入口：

1. `working/session-continuity/windows/WIN-20260914-CODEX-WEB-GPT-001/WINDOW-RECOVERY-MANIFEST-001.md`
2. `working/session-continuity/windows/WIN-20260914-CODEX-WEB-GPT-001/WHOLE-WINDOW-HANDOFF-CHECKPOINT-001.md`

协议语义沿用：
`Penrix/male-webnovel-cognition/.hermes/skills/mwne-session-continuation/SKILL.md`

要求：
- 先核对当前 PR #3 / branch / HEAD / CI live state；
- repo live state 高于 handoff；
- 恢复的不只是 WHAT，还要恢复 WHY / HOW：为什么从 Desktop-first 变成 CLI-first、哪些失败证伪了哪些假设、V7 为什么现在算成立；
- 不要把 CLI-first 误解为放弃 Desktop；
- 不要把 native passthrough 502、Web route、Interrupt hook、Full MCP、Desktop picker 混成同一个故障；
- 不要重新要求我安装 V7；
- 不要把启动时出现的 `codex.exe` 路径说成我手动输入；
- 先做恢复验收，再继续重型工作。

恢复后先用很短的握手告诉我：
1. 当前 Mother Problem；
2. 已经真正证明的事实；
3. 当前 bounded unknowns；
4. 下一合法 Work Unit；
5. 你为什么不会再回到旧的 reinstall/catalog 循环。
