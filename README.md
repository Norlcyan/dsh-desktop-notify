# dsh-desktop-notify

把 **DSH** 的三个关键时刻变成**桌面系统通知**：回合结束、等你选择、等你授权。

切到别的窗口写代码时，不用反复回头看 DSH 页面 —— 通知会自己找上来。

```
┌──────────────────────────────────────────┐
│ DeepSeek Harness                    now  │
│ 🔐 需要你授权                            │
│ 重构登录模块                             │
│ DSH 正在等你授权                         │
│ 工具：bash                               │
└──────────────────────────────────────────┘
```

## 为什么不是「音效就够了」

DSH 本身没有通知能力；`dsh-hooks-claude-code` 也不支持 Claude Code 的 `Notification` 事件
（30 个事件里 23 个未支持），所以 `hooks.json` 那条路走不通。

本插件直接挂在宿主侧的 `session/event` 上，**不依赖浏览器是否在前台**、不需要浏览器通知授权、
也不会因为标签页被节流而漏掉。

`dsh-whale-widget` 之类的音效插件可以同时装：音效 + 系统通知互不冲突，嫌吵就关掉音效。

## 安装

前提：Linux 桌面已有一个 `org.freedesktop.Notifications` 实现（mako / dunst / swaync /
Quickshell 系的 dms、noctalia 等），且 `notify-send` 可用（`libnotify`）。

**方式一（推荐）**：DSH Web → 插件 → 添加插件 → 填

```
github:Norlcyan/dsh-desktop-notify
```

**方式二**：

```bash
dsh plugin --profile web add github:Norlcyan/dsh-desktop-notify
```

装好后插件页会出现 `dsh-desktop-notify`，可开关。

## 事件映射

| DSH 事件 | 通知 | 默认 urgency |
|---|---|---|
| `turn/end` `reason.kind = completed` | ✅ 回答完毕 | `normal`（自动消失） |
| `turn/end` `error` / `aborted` / `blocked` / `max-tokens` / `interrupted` | ⚠️ ⏹ ⛔ 📏 🔌 对应文案 | `normal` |
| `tool/call` 且 `name = ask_user_question` | ❓ 需要你选择 | `critical`（常驻） |
| `approval/asked` | 🔐 需要你授权 | `critical`（常驻） |

- 等待类通知在你回答/批准后由 `approval/decided`、`tool/result` 触发
  `CloseNotification` 自动撤掉，不会赖在桌面上。
- 同一会话的回合结束通知用 `replace-id` 替换，不会越堆越多。
- 子代理会话默认不通知，避免一次任务弹一串。

## 配置

`~/.dsh/desktop-notify.json`，**每次事件重新读取，改完立即生效，不用重启**。
文件不存在时使用下面这套默认值：

```json
{
  "enabled": true,
  "showSessionName": true,
  "ignoreSubagents": true,
  "turnEnd":  { "on": true, "urgency": "normal",   "onlyCompleted": false },
  "question": { "on": true, "urgency": "critical" },
  "approval": { "on": true, "urgency": "critical" }
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关 |
| `showSessionName` | 通知正文带会话名（超过 24 字符截断） |
| `ignoreSubagents` | 子代理会话不通知 |
| `turnEnd.onlyCompleted` | 只在正常完成时通知，忽略 error/aborted 等 |
| `*.urgency` | `low` / `normal` / `critical`。`critical` 会 `-t 0` 常驻直到被处理 |

只想要等待类、不要回合结束：

```json
{ "turnEnd": { "on": false } }
```

## 排查

日志在 `~/.dsh/logs/desktop-notify.log`，每行一条 JSON：

```bash
tail -f ~/.dsh/logs/desktop-notify.log
```

关键记录：

| `event` | 含义 |
|---|---|
| `mounted` | 插件已挂载，含 `version` / `source` / `pid` |
| `notify` | 已发出通知，含 `id` / `urgency` / `summary` / `stderr` |
| `closed` | 已撤销一条挂起通知，含 `id` / `code` / `reason`（`settle:q`、`settle:a`、`turn-end`、`unmount`） |
| `close-error` | 撤销时 gdbus 启动失败 |
| `notify-spawn-error` | 找不到 `notify-send` |
| `handler-error` | 事件处理抛错（不影响宿主） |

链路自检（会真的弹一条通知）：

```bash
node ~/.dsh/profiles/web/node_modules/dsh-desktop-notify/lib/index.js --self-test
```

## 已知限制

- **点击通知不会跳回浏览器窗口**：`notify-send` 发完即退出，通知 daemon 点击时没有可激活的发起者。
  要跳转需要常驻持有 action 再调 compositor 的 IPC（如 `niri msg action focus-window`），尚未实现。
- **页面在前台时也会弹**：宿主侧无法判断浏览器窗口是否可见。介意就关掉 `turnEnd`。
- **日志不轮转**：`desktop-notify.log` 会持续增长，量很小（每条一行），需要时手动清空。

## 卸载

插件页关掉开关即可；彻底移除用「卸载」。配置与日志留在 `~/.dsh/` 下，可手动删。

## License

MIT
