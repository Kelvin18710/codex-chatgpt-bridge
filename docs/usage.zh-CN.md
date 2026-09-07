> 发布版首次安装默认仅手动。启用每任务策略入口请在仓库运行 `node scripts/install.mjs --enable-auto`；已有配置保留，触发模式在管理页设置。

# 咨询台 · ChatGPT Bridge

本机管理页：**http://127.0.0.1:9230/**

应用菜单打开 **ChatGPT 咨询管理**，或执行 `~/.local/bin/chatgpt-pro-manager`。管理页会启动本机服务并复用已有管理标签页。它只监听本机地址，无需构建或外部依赖，使用系统 Node.js 22。

## 用户操作

1. 在管理页点击“启动 Edge”，首次在专用浏览器中登录 ChatGPT。
2. 在“偏好设置”选择模型、触发方式、聊天方式和初始说明，点击“保存设置”。
3. 可点击“应用到网页”立即切换已保存的模型，或让工具在发送前自动选择。
4. 保留 Edge 运行，可以最小化。关闭启动终端不会关闭脚本启动的浏览器或管理服务。
5. “手动咨询”接受中文任务名称；同名任务可复用聊天并共用咨询次数。名称留空会创建独立临时任务。
6. “咨询记录”可搜索、查看问答与配置快照、打开原始 ChatGPT 会话、导出 Markdown/JSON、归档和恢复。

登录保存在 `~/.local/share/codex-chatgpt-edge`；正常情况下浏览器重启后无需重登。服务端过期、主动退出或安全验证仍可能要求登录，不承诺天数。

## 可配置内容

配置文件：`~/.config/codex-chatgpt-bridge/config.json`。保存前做完整字段与范围校验，写入时原子替换，并保留上一份 `.bak`。页面使用版本检查防止多个管理页互相覆盖。支持 JSON 导入、导出和恢复默认；导入/恢复先进入表单，点击保存才生效。

- **模型**：读取当前网页各系列的最高推理档位。原型测试环境曾读取到 6 Pro、5.6 Pro、5.5 Pro；你可用的选项以当前账号页面为准。支持发送前自动选择；不匹配时不会偷偷替换。显式“应用到网页”按钮也可在关闭自动选择时使用。
- **总开关**：暂停后，CLI 和管理页均不能提交新问题；已有记录仍可查询。
- **智能判断**：不同尝试失败阈值（1–10）、重要架构判断、证据冲突。
- **每个新任务**：每个新任务第一次处理时咨询一次，不是每条工具调用都发送。
- **仅手动**：用户明确要求，或在管理页点击发送。
- **聊天方式**：按任务复用；每次新咨询新建；跨任务复用最近聊天。跨任务复用会共享原上下文。明确追问始终使用原聊天。
- **标签页**：新建聊天时另开标签页，或复用当前专用标签页。旧网页聊天不会被删除。已有多个标签页时可以在设置页指定咨询标签页。
- **初始提示词**：可留空，最多 12000 字符；只在新聊天第一条附加，或每条咨询和追问都附加。它作为用户消息中的说明发送，不是 ChatGPT 后端系统提示词。
- **限额**：每任务 1–20 次发送尝试；等待预算 1–60 分钟；材料 1000–100000 字符。默认 2 次、15 分钟、50000 字符。

每次 CLI 调用重新读取配置。请求保存自己的配置快照，修改设置不会改写旧问题，也不会改变进行中回复的模型核对目标。自动触发通过 Codex 读取 Skill/个人 AGENTS 规则实现；管理页不监听 Codex 消息、不在后台自行判断或发送。已经运行的 Codex 会话应重新读取 Skill，新会话会加载个人规则。

## CLI

```bash
~/.local/bin/chatgpt-pro-start
~/.local/bin/chatgpt-pro-status --json
~/.local/bin/chatgpt-pro-manager
~/.local/bin/chatgpt-pro-consult policy
~/.local/bin/chatgpt-pro-consult decision --task task1 --event architecture
~/.local/bin/chatgpt-pro-consult ask --id task1-r1 --task task1 --event architecture --file /absolute/path/question.md
~/.local/bin/chatgpt-pro-consult poll --id task1-r1 --wait 30
~/.local/bin/chatgpt-pro-consult followup --parent task1-r1 --id task1-r2 --file /absolute/path/followup.md
~/.local/bin/chatgpt-pro-consult assess --id task1-r1 --file /absolute/path/assessment.md
```

事件为 `request`、`explicit`、`failure --attempts N`、`architecture` 或 `conflict`。CLI task/id 仍为 ASCII 标识；管理页把中文任务名映射为稳定内部标识并保留原名称。可选 `ask --task-name` 可为 CLI 记录指定友好名称。

重复同一 id 和内容只返回已有记录，不再发送；相同 id 内容改变则拒绝。规则和次数限制不能通过随意换 task 来绕过。

咨询 CLI 默认返回 JSON，退出 0 代表命令成功，不代表顾问已回答。状态以 `status`、`observation` 为准；退出 1 为错误，75 为另一命令占锁。一次 poll 最长等待 40 秒，累计超出请求的等待预算会标记 `waitBudgetExceeded`；管理页停止自动查询，可稍后手动检查。

## 恢复与记录

- 记录：`~/.local/state/codex-chatgpt-bridge/requests/<id>.json` 和 `.md`。
- 活动请求：`~/.local/state/codex-chatgpt-bridge/active.json`。
- 浏览器与管理服务日志：同目录的 `edge.log` 和 `manager.log`。
- Skill：`~/.codex/skills/chatgpt-pro-consult/SKILL.md`。
- 触发入口：`~/.codex/AGENTS.md`。

未知登录状态、草稿、进行中的回答或未知页面结构都会阻止发送。若点击发送之后发生页面读取超时，返回“发送待确认”状态，继续用同一 id 查询；不换编号重发。普通 poll 对完成的请求读本地缓存，`--refresh` 则重新验证当前网页；关闭标签页后可重新打开保存的 URL 再查询。

“放弃跟踪”或 `release --id ...` 只放弃本地跟踪，不取消服务端请求、不清空草稿。归档只隐藏历史列表行，不删除网页聊天、原始记录或防重复依据。

防重复保证限于本地工具同一 id 下的一次发送尝试。网页服务端与本地文件不是事务，不能证明服务端严格 exactly-once。页面模型标签也不是后端模型身份的独立证明。测试覆盖当前网页结构，不保证未来网页改版仍兼容。
