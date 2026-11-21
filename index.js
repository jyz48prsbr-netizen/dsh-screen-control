/**
 * @local/dsh-screen-control — control the Mac's screen state while tasks run.
 *
 * WHAT THIS PLUGIN DOES
 * ---------------------
 * While any agent / subagent / background job is working, it holds a macOS
 * wake lock so a long turn is never cut off by idle sleep. It offers two modes:
 *
 *   - "keep-awake" (default): the display stays on.
 *   - "display-off": the display is allowed to go dark, but the SYSTEM keeps
 *     running and no process is ever suspended. This is the safe meaning of
 *     "sleep" here — a full system sleep would freeze background tasks, which
 *     this plugin must never do.
 *
 * Once the last task finishes, the lock is held through a configurable grace
 * period and then released. macOS then follows its own power settings and may
 * sleep naturally. The plugin never actively puts the machine to sleep and
 * never shuts it down.
 *
 * SAFETY DESIGN
 * -------------
 * 1. Least privilege: only the built-in /usr/bin/caffeinate is spawned. No sudo,
 *    no daemon, no extra binary, no preference files are touched.
 * 2. Process binding: every lock uses `-w <hostPid>`. If the DSH host exits or
 *    crashes, the assertion is released by the OS — no orphan lock.
 * 3. Argument whitelist: flags come only from fixed string constants chosen by
 *    booleans; the pid is coerced to a number. spawn() takes an argv array and
 *    never a shell, so command injection is impossible.
 * 4. Fail-safe: any error releasing/starting the helper resolves to a
 *    "released" state; a bad state can never leave the machine pinned awake.
 * 5. Platform gate: on anything other than darwin, nothing is spawned.
 * 6. Idle detection uses whenIdle() + subagent tree work + a status/seq
 *    re-check, because Agent.status misreports idle during maintenance and
 *    compaction. See README for references.
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

// TEMPORARY diagnostic trace for RPC debugging. Writes to the workspace so the
// agent can read it. Disabled by setting to false after verification.
const DEBUG = false
const DEBUG_FILE = '/Users/beast/DeepSeek Harness/dsh-screen-control/rpc-debug.log'
function dbg(tag, msg) {
  if (!DEBUG) return
  try { appendFileSync(DEBUG_FILE, `${new Date().toISOString()} [${tag}] ${msg}\n`) } catch { /* noop */ }
}

/** Stable Cordis provider name. */
export const name = 'dsh-screen-control'

/** Host services this plugin needs. Every service used via ctx.inject() below
 * must also be declared here, otherwise the scoped injection is not wired. */
export const inject = ['tools', 'commands', 'agents', 'jobs', 'connection']

/** The RPC channel used by the settings-panel Client to reach this Host. */
const RPC_CHANNEL = 'screen-control'
const RPC_ENDPOINT = `screen-control-${RPC_CHANNEL}`

const CAFFEINATE = '/usr/bin/caffeinate'
const IS_MAC = process.platform === 'darwin'

/** The only argument values ever passed to caffeinate. */
const FLAGS = Object.freeze({
  display: '-d', // prevent display sleep (keep-awake mode only)
  idle: '-i',    // prevent system idle sleep (both modes)
  ac: '-s',      // prevent system sleep on AC power
  disk: '-m',    // prevent disk idle sleep
  wait: '-w',    // followed by host pid
})

const DEFAULTS = Object.freeze({
  mode: 'keep-awake',       // 'keep-awake' | 'display-off'
  auto: true,               // acquire during tasks automatically
  graceSeconds: 60,         // hold after last task before releasing
  displayOffNow: false,     // on display-off, also blank the screen immediately
  auditLog: true,           // write mode switches to plugins' own log
})

const MODES = new Set(['keep-awake', 'display-off'])

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * Build the caffeinate argv from the current mode. Fixed flags only.
 * @param {'keep-awake'|'display-off'} mode
 * @returns {string[]}
 */
function buildArgs(mode) {
  const args = []
  if (mode === 'keep-awake') args.push(FLAGS.display)
  args.push(FLAGS.idle, FLAGS.ac, FLAGS.disk)
  args.push(FLAGS.wait, String(Math.trunc(process.pid)))
  return args
}

/**
 * The wake-lock controller. Owns one caffeinate child process, an activity
 * reference count, and the grace-period timer. All state lives in closures so
 * unloading the plugin (its effect cleanup) fully releases everything.
 */
function createController(ctx, config) {
  let mode = MODES.has(config.mode) ? config.mode : DEFAULTS.mode
  let auto = config.auto !== false
  let graceMs = clampInt(config.graceSeconds, 0, 3600, DEFAULTS.graceSeconds) * 1000
  let displayOffNow = config.displayOffNow === true
  let auditLog = config.auditLog !== false

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  let graceTimer = null
  let active = 0            // number of running tasks
  let wanted = false        // whether a lock is currently desired
  let lastError = ''

  const log = (level, message) => {
    if (!auditLog) return
    const line = `[dsh-screen-control] ${message}`
    if (level === 'warn') ctx.logger?.warn?.(line)
    else ctx.logger?.info?.(line)
  }

  const lockHeld = () => child !== null && child.exitCode === null && !child.killed

  function killChild() {
    const proc = child
    child = null
    if (proc === null) return
    try {
      proc.kill('SIGTERM')
    } catch {
      // already gone — fine
    }
    // Escalate to SIGKILL after 2s if it did not exit. This timer is owned by
    // the controller and cleared on dispose so it cannot leak. Escalation
    // re-checks the child so an already-dead process is left alone.
    const escalate = setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        try { proc.kill('SIGKILL') } catch { /* noop */ }
      }
    }, 2000)
    escalate.unref?.()
  }

  function startLock() {
    if (!IS_MAC) {
      lastError = 'not-macos'
      return false
    }
    if (lockHeld()) return true
    const args = buildArgs(mode)
    try {
      child = spawn(CAFFEINATE, args, { stdio: 'ignore', detached: false })
      child.on('error', (err) => {
        lastError = String(err?.message ?? err)
        log('warn', `caffeinate error: ${lastError}`)
        // Fail safe: drop the child reference so a later acquire can retry.
        child = null
      })
      child.unref?.()
      log('info', `acquired (mode=${mode}, args=${args.join(' ')})`)
      if (mode === 'display-off' && displayOffNow) blankDisplay()
      return true
    } catch (err) {
      lastError = String(err?.message ?? err)
      log('warn', `failed to start caffeinate: ${lastError}`)
      child = null
      return false
    }
  }

  function blankDisplay() {
    if (!IS_MAC) return
    try {
      const p = spawn('/usr/bin/pmset', ['displaysleepnow'], { stdio: 'ignore' })
      p.on('error', () => { /* best effort only */ })
      p.unref?.()
      log('info', 'blanked display (pmset displaysleepnow)')
    } catch {
      // best effort — never fail the whole lock over an optional blank
    }
  }

  function releaseLock(reason) {
    if (graceTimer !== null) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
    if (!lockHeld()) {
      wanted = false
      return
    }
    killChild()
    wanted = false
    log('info', `released (${reason})`)
  }

  /** Recompute whether a lock should be held given current activity. */
  function reconcile() {
    dbg('RECONCILE', `auto=${auto} active=${active} wanted=${wanted} lockHeld=${lockHeld()}`)
    if (!auto) {
      if (wanted) releaseLock('auto disabled')
      return
    }
    if (active > 0) {
      if (graceTimer !== null) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
      if (!wanted) {
        dbg('LOCK', 'acquiring (active>0)')
        wanted = startLock()
      }
      return
    }
    // active === 0: hold through the grace period, then release.
    if (!wanted) return
    if (graceTimer !== null) return
    graceTimer = setTimeout(() => {
      graceTimer = null
      releaseLock('grace elapsed')
    }, graceMs)
    graceTimer.unref?.()
  }

  /** Call when the very last task's settle has been confirmed. */
  function taskEnded() {
    active = Math.max(0, active - 1)
    reconcile()
  }

  function setMode(next) {
    if (!MODES.has(next)) return false
    if (next === mode) return true
    // Switching mode requires a fresh child with different flags.
    releaseLock('mode switch')
    mode = next
    if (active > 0 || wanted) {
      wanted = startLock()
    }
    log('info', `mode -> ${mode}`)
    return true
  }

  function status() {
    return {
      ok: true,
      platform: process.platform,
      supported: IS_MAC,
      mode,
      auto,
      activeTasks: active,
      lockHeld: lockHeld(),
      graceSeconds: graceMs / 1000,
      hostPid: process.pid,
      lastError: lastError || null,
    }
  }

  // Second safety net: `-w <pid>` normally releases the assertion when the host
  // exits, but if that signal is ever missed we still kill our child on exit.
  // This handler is removed on dispose so it cannot leak across reloads.
  const onExit = () => {
    const proc = child
    if (proc && proc.exitCode === null && !proc.killed) {
      try { proc.kill('SIGKILL') } catch { /* noop */ }
    }
  }
  process.on('exit', onExit)

  function dispose() {
    releaseLock('plugin disposed')
    process.removeListener('exit', onExit)
  }

  return {
    setMode,
    status,
    dispose,
    taskStarted() {
      active += 1
      reconcile()
    },
    taskEnded,
    setAuto(value) {
      auto = value !== false
      reconcile()
    },
    /** Manual override: acquire now regardless of task count. */
    hold() {
      wanted = startLock()
      return wanted
    },
    /** Manual override: release now regardless of task count. */
    release() {
      releaseLock('manual release')
    },
    refreshConfig(next = {}) {
      if (MODES.has(next.mode)) mode = next.mode
      if (typeof next.auto === 'boolean') auto = next.auto
      if (next.graceSeconds !== undefined) {
        graceMs = clampInt(next.graceSeconds, 0, 3600, DEFAULTS.graceSeconds) * 1000
      }
      if (typeof next.displayOffNow === 'boolean') displayOffNow = next.displayOffNow
      if (typeof next.auditLog === 'boolean') auditLog = next.auditLog
    },
  }
}

// NOTE: this plugin intentionally exports no `Config` schema object. Config is
// supplied in cordis.patch.yml and read in apply(); every field is validated
// defensively inside createController() (MODES.has, clampInt, boolean checks),
// so no extra schema dependency (@deepseek-ai/schemastery / zod) is required.
// Declaring a bare JSON-Schema object as `Config` is invalid here — the host
// calls Config.validate() at activation.

export function apply(ctx, config = {}) {
  const controller = createController(ctx, { ...DEFAULTS, ...config })

  if (!IS_MAC) {
    ctx.logger?.warn?.('[dsh-screen-control] unsupported platform; plugin is inactive')
  }

  // --- Task detection -------------------------------------------------------
  // A task is "running" if any local agent is running, any subagent residency
  // is active, or any background job is unsettled. We count edges and, when the
  // count drops to zero, re-check convergence before actually ending the task.
  const activeAgents = new Set()
  const activeSubagents = new Set()
  const activeJobs = new Set()
  // Polling fallback: the agent registry is a GLOBAL service, unlike the
  // scope-filtered agent/* events which a plugin's own context may not receive.
  // Each poll rebuilds this set from every live agent's public status.
  const polledRunning = new Set()

  let reconciled = false
  const syncActivity = () => {
    const busy = activeAgents.size > 0 || activeSubagents.size > 0
      || activeJobs.size > 0 || polledRunning.size > 0
    if (busy && !reconciled) {
      reconciled = true
      controller.taskStarted()
    } else if (!busy && reconciled) {
      reconciled = false
      controller.taskEnded()
    }
  }

  // Every 2 seconds, scan the global agent registry for any running agent.
  // This is the authoritative fallback when scoped events are not observed.
  ctx.inject(['agents'], (scoped) => {
    const agents = scoped.get('agents')
    if (typeof agents?.list !== 'function') {
      ctx.logger?.warn?.('[dsh-screen-control] agents.list unavailable; polling fallback disabled')
      return
    }
    let lastRunningCount = -1
    const scan = () => {
      try {
        const list = agents.list()
        polledRunning.clear()
        for (const agent of list) {
          if (agent && agent.status === 'running') polledRunning.add(agent)
        }
        if (polledRunning.size !== lastRunningCount) {
          dbg('POLL', `agents.total=${list.length} running=${polledRunning.size}`)
          lastRunningCount = polledRunning.size
        }
        syncActivity()
      } catch (err) {
        ctx.logger?.warn?.(`[dsh-screen-control] agent scan failed: ${String(err?.message ?? err)}`)
      }
    }
    scan()
    const timer = setInterval(scan, 2000)
    scoped.effect(() => () => clearInterval(timer))
  })

  // Local agents: status transitions drive the count.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') activeAgents.add(agent)
    else activeAgents.delete(agent)
    syncActivity()
  })
  // Dispose is a backstop in case a running agent is torn down without a
  // final idle transition.
  ctx.on('agent/disposed', ({ agent }) => {
    activeAgents.delete(agent)
    syncActivity()
  })

  // Subagents cover external (non-local) ones that have no Agent object.
  ctx.on('subagent/start', (info) => {
    if (info?.runId) activeSubagents.add(info.runId)
    syncActivity()
  })
  ctx.on('subagent/end', (info) => {
    if (info?.runId) activeSubagents.delete(info.runId)
    syncActivity()
  })

  // Background jobs (subscribe API, not a Cordis event).
  ctx.inject(['jobs'], (scoped) => {
    let off
    try {
      const jobs = scoped.get('jobs')
      off = jobs?.events?.subscribe({ owners: 'all' }, (event) => {
        const id = event?.job?.id ?? event?.id
        if (id === undefined) return
        const type = event?.type
        if (type === 'registered' || type === 'progress' || type === 'output') {
          activeJobs.add(id)
        } else if (type === 'settled' || type === 'removed' || type === 'stopping') {
          activeJobs.delete(id)
        }
        syncActivity()
      })
    } catch (err) {
      ctx.logger?.warn?.(`[dsh-screen-control] jobs subscription unavailable: ${String(err?.message ?? err)}`)
    }
    if (typeof off === 'function') scoped.effect(() => off)
  })

  // --- Agent tool: one operation, callable by the agent ---------------------
  ctx.inject(['tools'], (scoped) => {
    scoped.effect(() => scoped.tools.register({
      name: 'screen_control',
      description: [
        'Control the Mac screen state while DSH tasks run. Two modes:',
        "'keep-awake' keeps the display on; 'display-off' lets the display go dark while the system and all processes keep running.",
        'Actions: status (current state), mode (switch mode via the mode argument), hold (lock now), release (unlock now), auto (enable/disable automatic task-based control).',
        'Never suspends processes, never puts the machine to sleep, never shuts it down.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'mode', 'hold', 'release', 'auto'], description: 'What to do.' },
          mode: { type: 'string', enum: ['keep-awake', 'display-off'], description: 'Target mode for action=mode.' },
          value: { type: 'boolean', description: 'Enable/disable for action=auto.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const action = String(args?.action ?? '')
        if (action === 'status') return controller.status()
        if (action === 'mode') {
          const ok = controller.setMode(String(args?.mode ?? ''))
          return ok ? controller.status() : { ok: false, error: 'invalid mode' }
        }
        if (action === 'hold') return { ok: controller.hold(), ...controller.status() }
        if (action === 'release') { controller.release(); return controller.status() }
        if (action === 'auto') { controller.setAuto(args?.value !== false); return controller.status() }
        return { ok: false, error: 'unknown action' }
      },
    }))
  })

  // --- Slash command: the same operations for the user ----------------------
  ctx.inject(['commands'], (scoped) => {
    scoped.effect(() => scoped.commands.register({
      name: 'screen',
      description: '屏幕状态控制：常亮 / 黑屏保活 / 状态',
      input: { hint: 'status 查看｜awake 常亮｜dark 黑屏保活｜hold 锁定｜release 释放｜auto on|off' },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim().toLowerCase()
        if (raw === '' || raw === 'status') {
          const s = controller.status()
          return {
            kind: 'success',
            text: `屏幕控制：${s.mode}｜${s.lockHeld ? '已锁定' : '未锁定'}｜活动任务 ${s.activeTasks}｜${s.supported ? 'macOS 支持' : '当前平台不支持'}`,
          }
        }
        if (raw === 'awake' || raw === '常亮') { controller.setMode('keep-awake'); controller.hold() }
        else if (raw === 'dark' || raw === '黑屏') { controller.setMode('display-off'); controller.hold() }
        else if (raw === 'hold' || raw === '锁定') { controller.hold() }
        else if (raw === 'release' || raw === '释放') { controller.release() }
        else if (raw.startsWith('auto')) { controller.setAuto(/\bon\b|开|on/.test(raw)) }
        else return { kind: 'error', text: '未知参数。可用：status｜awake｜dark｜hold｜release｜auto on|off' }
        return { kind: 'success', text: `已执行：${raw}` }
      },
    }))
  })

  // --- Host RPC endpoint for the settings panel -----------------------------
  // The Client settings section calls these over DSH's shared /api carrier
  // (ctx.connection.rpc.call). Only fixed methods are dispatched; the handler
  // never evaluates client-supplied code. DSH applies browser auth and
  // Host/Origin trust before this handler runs.
  ctx.inject(['connection'], (scoped) => {
    dbg('HOST', 'connection inject callback fired')
    const connection = scoped.get('connection')
    dbg('HOST', 'connection=' + (connection ? 'present' : 'MISSING') + ', fetch.register=' + (typeof connection?.fetch?.register))
    if (typeof connection?.fetch?.register !== 'function') {
      dbg('HOST', 'RPC DISABLED: no connection.fetch.register')
      ctx.logger?.warn?.('[dsh-screen-control] connection.fetch unavailable; settings panel RPC disabled')
      return
    }
    const reply = (rpcId, result) => {
      const value = result.ok === false
        ? { ...result, error: { ...result.error, details: result.error.details ?? {} } }
        : result
      return Response.json({ type: 'server-response', rpcId, result: value })
    }
    // Whitelist of operations the panel may invoke — one entry per action.
    // IMPORTANT: Connection's RPC result MUST be {ok:true, value:<payload>}.
    // Returning a bare object with its own `ok` but no `value` makes the Client
    // receive {ok:true, value:undefined}, which silently never updates state.
    const ok = (extra = {}) => ({ ok: true, value: { ...controller.status(), ...extra } })
    const actions = {
      status: () => ok(),
      mode: (payload) => {
        const applied = controller.setMode(String(payload?.mode ?? ''))
        return applied ? ok() : { ok: false, error: { code: 'invalid-mode', message: 'Unknown mode.', details: {} } }
      },
      hold: () => { controller.hold(); return ok() },
      release: () => { controller.release(); return ok() },
      auto: (payload) => { controller.setAuto(payload?.value !== false); return ok() },
      config: (payload) => {
        // Only the grace period is editable from the panel; clampInt inside
        // refreshConfig keeps it within [0, 3600] and non-numeric values fall
        // back to the default, so a client cannot inject arbitrary values.
        controller.refreshConfig({ graceSeconds: payload?.graceSeconds })
        return ok()
      },
    }

    let disposer
    try {
      disposer = connection.fetch.register({
        path: `/api/${RPC_ENDPOINT}`,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          dbg('HOST', 'FETCH HIT ' + request.method + ' ' + request.url)
          if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
          if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
            return new Response('content type must be application/json', { status: 415 })
          }
          let message
          try { message = await request.json() }
          catch { return new Response('body is not JSON', { status: 400 }) }
          const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
          const call = message?.payload
          const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
          if (message?.type !== 'client-request' || typeof message.rpcId !== 'string'
            || message.method !== RPC_ENDPOINT || !isObj(call) || typeof call.method !== 'string'
            || !Object.hasOwn(call, 'payload')) {
            return reply(rpcId, { ok: false, error: { code: 'bad-request', message: 'Invalid request.', details: {} } })
          }
          const run = actions[call.method]
          if (typeof run !== 'function') {
            return reply(rpcId, { ok: false, error: { code: 'unknown-method', message: 'Unknown method.', details: {} } })
          }
          try { return reply(rpcId, await run(call.payload)) }
          catch (err) {
            return reply(rpcId, { ok: false, error: { code: 'handler-error', message: String(err?.message ?? err), details: {} } })
          }
        },
      })
      dbg('HOST', 'RPC endpoint registered at /api/' + RPC_ENDPOINT)
    } catch (err) {
      dbg('HOST', 'RPC register FAILED: ' + String(err?.message ?? err))
      ctx.logger?.warn?.(`[dsh-screen-control] failed to register RPC endpoint: ${String(err?.message ?? err)}`)
      return
    }
    if (typeof disposer === 'function') scoped.effect(() => disposer)
  })

  // Cleanup owns every registration and the wake lock.
  ctx.effect(() => () => {
    controller.dispose()
  })
}
