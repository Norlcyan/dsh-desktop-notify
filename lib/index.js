/**
 * dsh-desktop-notify — 把 DSH 的关键时刻变成桌面通知。
 *
 * 数据源全部来自宿主侧的 `session/event`，不依赖浏览器是否在前台：
 *   - `turn/end`         回合结束（completed / error / aborted / blocked / max-tokens / interrupted）
 *   - `tool/call`        name === 'ask_user_question' → 等待你选择
 *   - `approval/asked`   等待你授权；`approval/decided` 到达时撤销通知
 *
 * 通知走 `notify-send`（org.freedesktop.Notifications）。Wayland + Niri 下由
 * dms/Quickshell 或 mako/dunst/swaync 等任意实现接住，无需额外配置。
 *
 * 安装：DSH 插件页「添加插件」填 `github:Norlcyan/dsh-desktop-notify`。
 *       包内 cordis.patch.yml 是 bundle patch，安装后自动插进配置树。
 *
 * 配置：~/.dsh/desktop-notify.json（每次事件读取，改完立即生效）
 * 日志：~/.dsh/logs/desktop-notify.log（每行一条 JSON，排查用）
 * 自检：node <包目录>/lib/index.js --self-test
 */

/** 包版本，与 package.json 同步；只出现在日志与自检输出里。 */
const VERSION = '0.1.0'

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), '.dsh')
const CONFIG_PATH = join(DSH_HOME, 'desktop-notify.json')
const LOG_PATH = join(DSH_HOME, 'logs', 'desktop-notify.log')
const APP_NAME = 'DeepSeek Harness'

const DEFAULTS = {
  enabled: true,
  showSessionName: true,
  ignoreSubagents: true,
  turnEnd: { on: true, urgency: 'normal', onlyCompleted: false },
  question: { on: true, urgency: 'critical' },
  approval: { on: true, urgency: 'critical' },
}

function readConfig() {
  let raw
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return clone(DEFAULTS)
  }
  if (!raw || typeof raw !== 'object') return clone(DEFAULTS)
  const pick = (key) => (raw[key] && typeof raw[key] === 'object'
    ? { ...clone(DEFAULTS[key]), ...raw[key] }
    : clone(DEFAULTS[key]))
  return {
    ...clone(DEFAULTS),
    ...raw,
    turnEnd: pick('turnEnd'),
    question: pick('question'),
    approval: pick('approval'),
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function log(entry) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    /* 日志失败绝不影响宿主 */
  }
}

/** DSH 进程一般已继承 session bus；缺省时按 XDG_RUNTIME_DIR 兜底。 */
function busEnv() {
  const env = { ...process.env }
  if (!env.DBUS_SESSION_BUS_ADDRESS && env.XDG_RUNTIME_DIR) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${env.XDG_RUNTIME_DIR}/bus`
  }
  return env
}

/**
 * 发一条通知。
 * @returns {Promise<number|null>} notify-send -p 打印的通知 id，失败为 null。
 */
function send({ summary, body, urgency = 'normal', replaceId }) {
  return new Promise((resolve) => {
    const args = ['-a', APP_NAME, '-u', urgency, '-p']
    if (urgency === 'critical') args.push('-t', '0') // critical 常驻，直到被 CloseNotification
    if (replaceId) args.push('-r', String(replaceId))
    args.push(summary, body)

    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    try {
      const child = spawn('notify-send', args, { env: busEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => { out += chunk })
      child.stderr.on('data', (chunk) => { err += chunk })
      child.on('error', (error) => {
        log({ event: 'notify-spawn-error', error: String(error), summary })
        done(null)
      })
      child.on('close', (code) => {
        const id = Number.parseInt(String(out).trim(), 10)
        const notifyId = Number.isFinite(id) ? id : null
        log({
          event: 'notify',
          code,
          id: notifyId,
          urgency,
          summary,
          ...(err.trim() ? { stderr: err.trim().slice(0, 300) } : {}),
        })
        done(notifyId)
      })
    } catch (error) {
      log({ event: 'notify-throw', error: String(error), summary })
      done(null)
    }
  })
}

/** 撤掉一条还没有被点的通知（回答/批准之后调用）。 */
function closeNotification(id) {
  if (!id) return
  try {
    const child = spawn('gdbus', [
      'call', '--session',
      '--dest', 'org.freedesktop.Notifications',
      '--object-path', '/org/freedesktop/Notifications',
      '--method', 'org.freedesktop.Notifications.CloseNotification',
      String(id),
    ], { env: busEnv(), stdio: 'ignore' })
    child.on('error', () => {})
  } catch {
    /* 关闭失败不影响流程 */
  }
}

const TURN_END_SUMMARY = {
  completed: '✅ 回答完毕',
  error: '⚠️ 回合出错',
  aborted: '⏹ 回合已中止',
  blocked: '⛔ 回合被阻断',
  'max-tokens': '📏 输出达到上限',
  interrupted: '🔌 会话已中断',
}

const plugin = {
  name: 'dsh-desktop-notify',

  apply(ctx) {
    /** key -> 通知 id；key 为 `${kind}:${sessionId}:${eventId}` */
    const pending = new Map()
    /** sessionId -> 会话名缓存（session/title 事件与 sessionTitle 服务两路） */
    const titles = new Map()
    /** sessionId -> 上一轮 turn/end 的通知 id，用 -r 替换避免堆叠 */
    const lastTurnNotify = new Map()

    const keyOf = (kind, sid, id) => `${kind}:${sid}:${id}`

    function titleOf(session) {
      const sid = String(session?.id || '')
      if (sid && titles.has(sid)) return titles.get(sid)
      try {
        const service = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null
        if (service && typeof service.get === 'function' && session) {
          const snapshot = service.get(session)
          const title = typeof snapshot === 'string' ? snapshot : (snapshot && (snapshot.title || snapshot.text))
          if (title) {
            const value = String(title).trim()
            if (sid) titles.set(sid, value)
            return value
          }
        }
      } catch {
        /* 老宿主没有该服务时静默回落 */
      }
      return ''
    }

    function isSubagent(session) {
      try {
        return session?.header?.origin === 'subagent'
      } catch {
        return false
      }
    }

    function labelOf(session, config) {
      if (!config.showSessionName) return ''
      const title = titleOf(session)
      if (!title) return ''
      return title.length > 24 ? `${title.slice(0, 24)}…` : title
    }

    function track(kind, sid, id, notifyId) {
      if (notifyId) pending.set(keyOf(kind, sid, id), notifyId)
    }

    function settle(kind, sid, id) {
      const key = keyOf(kind, sid, id)
      const notifyId = pending.get(key)
      if (notifyId) {
        pending.delete(key)
        closeNotification(notifyId)
      }
    }

    function settleSession(sid) {
      for (const [key, notifyId] of [...pending]) {
        if (key.includes(`:${sid}:`)) {
          pending.delete(key)
          closeNotification(notifyId)
        }
      }
    }

    function handle(session, event) {
      const type = String(event?.type || '')
      const data = event?.data || {}
      const sid = String(session?.id || '')

      // 会话标题：既是通知文案来源，也顺带覆盖 sessionTitle 服务读不到的旧会话
      if (type === 'session/title') {
        const title = String(data.title == null ? '' : data.title).trim()
        if (title && sid) titles.set(sid, title)
        return
      }

      const config = readConfig()
      if (!config.enabled) return
      if (config.ignoreSubagents && isSubagent(session)) return

      if (type === 'tool/call' && String(data.name || '') === 'ask_user_question') {
        if (!config.question.on) return
        const callId = String(data.callId || '')
        const key = keyOf('q', sid, callId)
        if (pending.has(key)) return
        const label = labelOf(session, config)
        const body = [label, 'DSH 正在等你回答/选择'].filter(Boolean).join('\n')
        void send({ summary: '❓ 需要你选择', body, urgency: config.question.urgency })
          .then((notifyId) => track('q', sid, callId, notifyId))
        return
      }

      if (type === 'tool/result') {
        const callId = String(data?.message?.toolCallId || '')
        if (callId) settle('q', sid, callId)
        return
      }

      if (type === 'approval/asked') {
        if (!config.approval.on) return
        const id = String(data.id || '')
        const key = keyOf('a', sid, id)
        if (pending.has(key)) return
        const label = labelOf(session, config)
        const toolName = String(data.toolName || '').trim()
        const reason = String(data.reason || '').trim()
        const body = [
          label,
          'DSH 正在等你授权',
          toolName ? `工具：${toolName}` : '',
          reason ? reason.slice(0, 120) : '',
        ].filter(Boolean).join('\n')
        void send({ summary: '🔐 需要你授权', body, urgency: config.approval.urgency })
          .then((notifyId) => track('a', sid, id, notifyId))
        return
      }

      if (type === 'approval/decided') {
        const id = String(data.id || '')
        if (id) settle('a', sid, id)
        return
      }

      if (type === 'turn/end') {
        // 回合结束意味着挂起必已解除，先撤掉残留的等待类通知
        settleSession(sid)
        if (!config.turnEnd.on) return
        const kind = String(data?.reason?.kind || 'completed')
        if (kind === 'forked') return
        if (config.turnEnd.onlyCompleted && kind !== 'completed') return

        const label = labelOf(session, config)
        const failure = kind === 'error' ? String(data?.reason?.error?.message || '').trim() : ''
        const body = [label, failure.slice(0, 160)].filter(Boolean).join('\n') || APP_NAME
        const previous = lastTurnNotify.get(sid)
        void send({
          summary: TURN_END_SUMMARY[kind] || 'ℹ️ 回合结束',
          body,
          urgency: config.turnEnd.urgency,
          replaceId: previous,
        }).then((notifyId) => {
          if (notifyId) lastTurnNotify.set(sid, notifyId)
        })
      }
    }

    ctx.effect(() => {
      let off = null
      try {
        off = ctx.on('session/event', (session, event) => {
          try {
            handle(session, event)
          } catch (error) {
            log({ event: 'handler-error', error: String(error) })
          }
        })
      } catch (error) {
        log({ event: 'subscribe-error', error: String(error) })
      }
      log({
        event: 'mounted',
        version: VERSION,
        source: fileURLToPath(import.meta.url),
        configPath: CONFIG_PATH,
        pid: process.pid,
      })
      return () => {
        try {
          if (typeof off === 'function') off()
        } catch { /* ignore */ }
        for (const notifyId of pending.values()) closeNotification(notifyId)
        pending.clear()
        lastTurnNotify.clear()
        log({ event: 'unmounted' })
      }
    })
  },
}

export default plugin

// 直接运行时自检：node lib/index.js --self-test
if (process.argv.includes('--self-test')) {
  const selfPath = fileURLToPath(import.meta.url)
  const invokedDirectly = process.argv[1] && process.argv[1] === selfPath
  if (invokedDirectly) {
    void send({ summary: '✅ DSH 通知插件自检', body: `见得到这条 = notify-send 链路正常（v${VERSION}）`, urgency: 'normal' })
      .then((id) => {
        console.log(id === null ? 'FAILED: notify-send 没拿到通知 id' : `OK: notification id=${id}`)
        if (id) setTimeout(() => closeNotification(id), 4000)
      })
  }
}
