window.__ModuleLoader__.load({
  id: 'dsh-screen-control',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'dsh-screen-control'
    const RPC_ENDPOINT = 'screen-control-screen-control'
    const RPC_CHANNEL = 'screen-control'

    const DICT = {
      zh: {
        nav: '屏幕状态控制',
        title: '屏幕状态控制',
        desc: '任务运行期间控制屏幕状态，绝不挂起进程、不让系统睡眠或关机。任务结束后按宽限期释放唤醒锁，系统按自身设置自然睡眠。仅 macOS 生效。',
        modeLabel: '运行期间模式',
        modeAwake: '常亮（屏幕不熄）',
        modeDark: '黑屏保活（屏灭、进程继续跑）',
        autoLabel: '任务期间自动生效',
        graceLabel: '释放宽限期（秒）',
        statusTitle: '实时状态',
        statusMode: '当前模式',
        statusLock: '唤醒锁',
        statusTasks: '活动任务',
        statusPid: '宿主进程',
        statusPlatform: '平台支持',
        locked: '已锁定',
        unlocked: '未锁定',
        supported: '支持',
        unsupported: '不支持',
        modeAwakeShort: '常亮',
        modeDarkShort: '黑屏保活',
        hold: '立即锁定',
        release: '立即释放',
        refresh: '刷新状态',
        saving: '处理中…',
        note: '面板操作与 /screen 指令、screen_control 工具等效。',
        errPrefix: '操作失败：',
      },
      en: {
        nav: 'Screen state control',
        title: 'Screen state control',
        desc: 'Controls the screen state while tasks run, never suspending processes or sleeping/shutting down the machine. After the last task it releases the wake lock after a grace period. macOS only.',
        modeLabel: 'Mode while tasks run',
        modeAwake: 'Keep awake (display stays on)',
        modeDark: 'Display off (screen dark, processes keep running)',
        autoLabel: 'Automatic during tasks',
        graceLabel: 'Release grace period (seconds)',
        statusTitle: 'Live status',
        statusMode: 'Current mode',
        statusLock: 'Wake lock',
        statusTasks: 'Active tasks',
        statusPid: 'Host pid',
        statusPlatform: 'Platform',
        locked: 'Held',
        unlocked: 'Not held',
        supported: 'Supported',
        unsupported: 'Unsupported',
        modeAwakeShort: 'Keep awake',
        modeDarkShort: 'Display off',
        hold: 'Hold now',
        release: 'Release now',
        refresh: 'Refresh',
        saving: 'Working…',
        note: 'Same operations as the /screen command and the screen_control tool.',
        errPrefix: 'Failed: ',
      },
    }

    function Switch({ on, onClick, label }) {
      return h('div', {
        role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label,
        onClick: onClick,
        style: {
          display: 'inline-flex', alignItems: 'center', width: 36, height: 20,
          borderRadius: 10, padding: 2, boxSizing: 'border-box', flexShrink: 0,
          cursor: 'pointer',
          background: on ? 'var(--dsw-alias-brand-primary, #3370ff)' : 'var(--dsw-alias-border-l3, #888)',
          transition: 'background .15s',
        },
      },
        h('span', {
          style: {
            width: 16, height: 16, borderRadius: '50%', background: '#fff',
            transform: on ? 'translateX(16px)' : 'translateX(0)',
            transition: 'transform .15s', boxShadow: '0 1px 2px rgba(0,0,0,.25)',
          },
        })
      )
    }

    function Panel({ t, rpc, initial }) {
      const [status, setStatus] = useState(initial || null)
      const [graceInput, setGraceInput] = useState(String(initial?.graceSeconds ?? 60))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const alive = useRef(true)
      useEffect(function () { alive.current = true; return function () { alive.current = false } }, [])
      // Keep the input in sync when status is refreshed from the Host.
      useEffect(function () {
        if (status && typeof status.graceSeconds === 'number') setGraceInput(String(status.graceSeconds))
      }, [status?.graceSeconds])

      const call = useCallback(async function (method, payload) {
        setBusy(true); setError('')
        try {
          const result = await rpc(method, payload || {})
          if (!result || result.ok !== true) {
            setError(t('errPrefix') + (result?.error?.message || 'unknown'))
            return null
          }
          const value = result.value
          if (value && alive.current) setStatus(value)
          return value
        } catch (e) {
          if (alive.current) setError(t('errPrefix') + String(e?.message ?? e))
          return null
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [rpc, t])

      // Poll status every 3s so task-driven lock changes show up live.
      useEffect(function () {
        const id = setInterval(function () { call('status') }, 3000)
        return function () { clearInterval(id) }
      }, [call])

      const mode = status?.mode || 'keep-awake'
      const rowStyle = {
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 8,
        background: 'transparent', fontSize: 14,
      }
      const btnStyle = {
        padding: '6px 12px', borderRadius: 6, cursor: busy ? 'default' : 'pointer', fontSize: 13,
        border: '1px solid var(--dsw-alias-border-l2, #ddd)',
        background: 'transparent', color: 'inherit', opacity: busy ? 0.6 : 1,
      }

      return h('div', { style: { padding: '8px 4px', color: 'var(--dsw-alias-label-primary)' } },
        h('h3', { style: { margin: '0 0 4px', fontSize: 16 } }, t('title')),
        h('p', { style: { margin: '0 0 16px', opacity: 0.75, fontSize: 13, lineHeight: 1.5 } }, t('desc')),

        // Mode radios
        h('div', { style: { marginBottom: 14 } },
          h('div', { style: { fontSize: 13, opacity: 0.8, marginBottom: 6 } }, t('modeLabel')),
          [['keep-awake', 'modeAwake'], ['display-off', 'modeDark']].map(function (pair) {
            const key = pair[0]; const label = pair[1]
            return h('label', { key: key, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px', cursor: 'pointer', fontSize: 14 } },
              h('input', {
                type: 'radio', name: 'dsh-sc-mode', value: key, checked: mode === key,
                onChange: function () { call('mode', { mode: key }) },
              }),
              t(label)
            )
          })
        ),

        // Auto toggle
        h('div', Object.assign({}, rowStyle, { marginBottom: 10 }),
          h('span', { style: { flex: 1 } }, t('autoLabel')),
          h(Switch, { on: status?.auto !== false, label: t('autoLabel'), onClick: function () { call('auto', { value: !(status?.auto !== false) }) } })
        ),

        // Grace period
        h('div', Object.assign({}, rowStyle, { marginBottom: 16 }),
          h('span', { style: { flex: 1 } }, t('graceLabel')),
          h('input', {
            type: 'number', min: 0, max: 3600, step: 1,
            value: graceInput,
            onChange: function (ev) { setGraceInput(ev.target.value) },
            onBlur: function () { call('config', { graceSeconds: Number(graceInput) }) },
            onKeyDown: function (ev) { if (ev.key === 'Enter') ev.target.blur() },
            style: { width: 80, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #ddd)', background: 'transparent', color: 'inherit' },
          })
        ),

        // Live status
        h('div', { style: { border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 8, padding: '10px 12px', marginBottom: 14 } },
          h('div', { style: { fontSize: 13, opacity: 0.8, marginBottom: 8 } }, t('statusTitle')),
          [
            [t('statusMode'), mode === 'keep-awake' ? t('modeAwakeShort') : t('modeDarkShort')],
            [t('statusLock'), status?.lockHeld ? t('locked') : t('unlocked')],
            [t('statusTasks'), String(status?.activeTasks ?? 0)],
            [t('statusPid'), String(status?.hostPid ?? '-')],
            [t('statusPlatform'), status?.supported ? t('supported') : t('unsupported')],
          ].map(function (pair) {
            return h('div', { key: pair[0], style: { display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 13 } },
              h('span', { style: { opacity: 0.8 } }, pair[0]),
              h('span', {}, pair[1])
            )
          })
        ),

        // Buttons
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', disabled: busy, style: btnStyle, onClick: function () { call('hold') } }, t('hold')),
          h('button', { type: 'button', disabled: busy, style: btnStyle, onClick: function () { call('release') } }, t('release')),
          h('button', { type: 'button', disabled: busy, style: btnStyle, onClick: function () { call('status') } }, t('refresh')),
          busy ? h('span', { style: { opacity: 0.6, fontSize: 12 } }, t('saving')) : null
        ),

        error ? h('div', { style: { marginTop: 10, color: '#f53f3f', fontSize: 12 } }, error) : null,
        h('div', { style: { marginTop: 12, opacity: 0.55, fontSize: 12 } }, t('note'))
      )
    }

    // Minimal initial state before the first RPC round-trip.
    function initialStatus() {
      return {
        mode: 'keep-awake', auto: true, lockHeld: false, activeTasks: 0,
        hostPid: '-', supported: true, graceSeconds: 60,
      }
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-screen-control: dictionaries')

        const rpc = async function (method, payload) {
          return await ctx.connection.rpc.call('/api', RPC_ENDPOINT, { method, payload: payload || {} })
        }

        // Fetch the real status once on mount via a tiny wrapper that loads it
        // before rendering the panel.
        let stopSettings = null
        const mount = function () {
          stopSettings = ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-screen-control',
            order: 88,
            label: function () { return ctx.locale.bind(NS)('nav') },
            locale: NS,
            inject: function () {
              return { t: ctx.locale.bind(NS), rpc: rpc, initial: initialStatus() }
            },
          }, Panel))
        }
        mount()

        ctx.effect(() => function () {
          if (typeof stopSettings === 'function') stopSettings()
        }, 'dsh-screen-control: settings section')
      },
    }
  },
})
