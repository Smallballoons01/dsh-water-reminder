/**
 * Browser half of @dsh-plugin/water-reminder.
 *
 * Contributes two surfaces, both fed by the host half's `/water/api` routes:
 *
 * - `sidebar.footer.action` — a 💧 button that carries the live countdown to the
 *   next reminder, opening a panel with today's progress, a 7-day sparkline, and
 *   the quick actions (log a cup, snooze, remind now, pause).
 * - `settings.section` — the full configuration page: interval band, goal and
 *   cup size, quiet hours, and which delivery channels are on.
 *
 * The panel is also the plugin's browser-notification channel: it watches the
 * host's `reminderSeq`, so when a reminder fires while the page is open the tab
 * raises its own notification.
 *
 * Hand-written in the `__ModuleLoader__` closure format so the package needs no
 * build step; `require()` resolves only the platform seed (react), and the
 * styles are inline over the dsh design tokens (`--dsw-alias-*`) so the panel
 * follows the shell's light/dark theme.
 */
window.__ModuleLoader__.load({
  id: '@dsh-plugin/water-reminder',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'water-reminder'
    const zh = (navigator.language || '').toLowerCase().startsWith('zh')
    const t = zh
      ? {
        button: '喝水',
        buttonPaused: '已暂停',
        title: '喝水提醒',
        refresh: '刷新',
        today: '今日',
        remaining: '还差',
        done: '目标达成',
        cups: '杯',
        streak: '连续达标',
        days: '天',
        next: '下次提醒',
        notScheduled: '未排程',
        quiet: '安静时段',
        quietHint: '安静时段内提醒会顺延到窗口结束',
        week: '近 7 天',
        log: '喝了一杯',
        logCustom: '记录',
        snooze: '稍后 5 分钟',
        now: '立刻提醒',
        pause: '暂停',
        resume: '启用',
        browserNotify: '浏览器通知',
        browserDenied: '浏览器已拒绝通知权限',
        browserGranted: '浏览器通知已开启',
        loading: '加载中…',
        failed: '读取失败',
        ml: 'ml',
        minutes: '分钟',
        settingsTitle: '喝水提醒',
        settingsIntro: '默认每 40–60 分钟随机提醒一次。区间不固定是有意的：规律到能被预判的提醒最容易被忽略。',
        settingsSchedule: '提醒节奏',
        settingsGoal: '目标与份量',
        settingsQuiet: '安静时段',
        settingsChannels: '提醒渠道',
        settingsAdvanced: '高级',
        enabled: '启用提醒',
        intervalMin: '区间下限（分钟）',
        intervalMax: '区间上限（分钟）',
        goalMl: '每日目标（ml）',
        cupMl: '每杯容量（ml）',
        snoozeMinutes: '「稍后」默认顺延（分钟）',
        quietEnabled: '启用安静时段',
        quietFrom: '开始',
        quietTo: '结束',
        channelOs: '系统通知',
        channelAgent: '会话内提醒（助手说一句）',
        channelSound: '系统通知带提示音',
        promptSection: '向助手注入提醒说明（需重启）',
        skillToggle: '注册内置 hydration-coach 技能（需重启）',
        stateFile: '状态文件',
        statePath: '存放位置',
        save: '保存',
        discard: '放弃',
        saved: '已保存',
        restartHint: '标「需重启」的开关在重载 Harness 后生效。',
        unavailable: '设置服务当前不可用。',
        readonly: '设置当前只读。',
      }
      : {
        button: 'Water',
        buttonPaused: 'Paused',
        title: 'Water reminder',
        refresh: 'Refresh',
        today: 'Today',
        remaining: 'Left',
        done: 'Goal reached',
        cups: 'cups',
        streak: 'Goal streak',
        days: 'd',
        next: 'Next reminder',
        notScheduled: 'Not scheduled',
        quiet: 'Quiet hours',
        quietHint: 'Reminders during quiet hours resume when the window ends',
        week: 'Last 7 days',
        log: 'Log a cup',
        logCustom: 'Log',
        snooze: 'Snooze 5 min',
        now: 'Remind now',
        pause: 'Pause',
        resume: 'Resume',
        browserNotify: 'Browser notification',
        browserDenied: 'Browser notification permission was denied',
        browserGranted: 'Browser notifications on',
        loading: 'Loading…',
        failed: 'Request failed',
        ml: 'ml',
        minutes: 'min',
        settingsTitle: 'Water reminder',
        settingsIntro: 'Reminds every 40–60 minutes by default, drawn fresh each time. The irregular rhythm is deliberate: a predictable timer is the one people learn to ignore.',
        settingsSchedule: 'Rhythm',
        settingsGoal: 'Goal and portion',
        settingsQuiet: 'Quiet hours',
        settingsChannels: 'Channels',
        settingsAdvanced: 'Advanced',
        enabled: 'Reminders enabled',
        intervalMin: 'Interval lower bound (min)',
        intervalMax: 'Interval upper bound (min)',
        goalMl: 'Daily goal (ml)',
        cupMl: 'Cup size (ml)',
        snoozeMinutes: 'Default snooze (min)',
        quietEnabled: 'Enable quiet hours',
        quietFrom: 'From',
        quietTo: 'To',
        channelOs: 'OS notification',
        channelAgent: 'In-conversation nudge',
        channelSound: 'Play a sound',
        promptSection: 'Inject the reminder briefing into the agent (restart)',
        skillToggle: 'Register the embedded hydration-coach skill (restart)',
        stateFile: 'State file',
        statePath: 'Location',
        save: 'Save',
        discard: 'Discard',
        saved: 'Saved',
        restartHint: 'Switches marked "(restart)" apply after reloading Harness.',
        unavailable: 'Settings are unavailable.',
        readonly: 'Settings are read-only.',
      }

    const STYLE = `
.dsh-wr-button { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary, CanvasText); font-size: 12px; cursor: pointer; font-variant-numeric: tabular-nums; }
.dsh-wr-button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dsh-wr-button-off { opacity: .6; }
.dsh-wr-panel { position: fixed; z-index: 1000; width: 306px; display: flex; flex-direction: column; overflow: hidden; background: var(--dsw-alias-bg-layer-1, Canvas); color: var(--dsw-alias-label-primary, CanvasText); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.18); font-size: 12px; }
.dsh-wr-head { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.15)); font-weight: 600; }
.dsh-wr-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary, GrayText); cursor: pointer; font-size: 12px; }
.dsh-wr-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, CanvasText); }
.dsh-wr-body { padding: 12px; display: grid; gap: 10px; }
.dsh-wr-hero { display: flex; align-items: baseline; gap: 6px; }
.dsh-wr-big { font-size: 26px; line-height: 30px; font-weight: 650; font-variant-numeric: tabular-nums; }
.dsh-wr-unit { color: var(--dsw-alias-label-tertiary, GrayText); }
.dsh-wr-sub { margin-left: auto; color: var(--dsw-alias-label-tertiary, GrayText); }
.dsh-wr-track { position: relative; height: 6px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); }
.dsh-wr-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-state-business-primary, #4c8dff); transition: width .25s ease; }
.dsh-wr-fill-done { background: var(--dsw-alias-state-success-primary, #4caf50); }
.dsh-wr-stats { display: flex; gap: 12px; color: var(--dsw-alias-label-tertiary, GrayText); }
.dsh-wr-stats b { color: var(--dsw-alias-label-primary, CanvasText); font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-wr-next { display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); }
.dsh-wr-next-count { margin-left: auto; font-weight: 650; font-variant-numeric: tabular-nums; }
.dsh-wr-quiet { color: var(--dsw-alias-state-warn-label, #b57708); font-size: 11px; }
.dsh-wr-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-wr-actions button { flex: 1 1 auto; min-height: 28px; padding: 4px 10px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.dsh-wr-actions button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dsh-wr-actions button:disabled { opacity: .5; cursor: default; }
/* 填充色写死。不能用 brand-text / brand-primary 之类的 token —— 它们在本设计系统里
   取的是「中性强调色」（浅色主题近黑、深色主题近白），铺成按钮底就成了浅底白字。
   中蓝配白字是 5.5:1，两种主题下都清楚。 */
.dsh-wr-primary { color: #fff !important; background: #3d5fd9 !important; border-color: #3d5fd9 !important; }
.dsh-wr-week { display: flex; align-items: flex-end; gap: 4px; height: 42px; }
.dsh-wr-bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
.dsh-wr-bar i { display: block; border-radius: 3px 3px 0 0; background: var(--dsw-alias-state-business-primary, #4c8dff); opacity: .55; }
.dsh-wr-bar-today i { opacity: 1; }
.dsh-wr-bar span { margin-top: 3px; text-align: center; color: var(--dsw-alias-label-tertiary, GrayText); font-size: 9px; }
.dsh-wr-note { color: var(--dsw-alias-label-tertiary, GrayText); }
.dsh-wr-error { padding: 5px 8px; border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover-danger, rgba(224,108,117,.12)); color: var(--dsw-alias-state-error-primary, #e06c75); word-break: break-all; }
.dsh-wr-foot { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.15)); color: var(--dsw-alias-label-tertiary, GrayText); }

.dsh-wr-page { display: grid; gap: 24px; max-width: 720px; font: 13px/20px system-ui, sans-serif; }
.dsh-wr-page h2, .dsh-wr-page h3, .dsh-wr-page p { margin: 0; }
.dsh-wr-page h2 { font-size: 20px; line-height: 28px; }
.dsh-wr-page h3 { font-size: 14px; line-height: 20px; }
.dsh-wr-page header { display: grid; gap: 8px; max-width: 65ch; }
.dsh-wr-page .dsh-wr-muted { color: rgba(128,128,128,.9); }
.dsh-wr-page .dsh-wr-section { display: grid; gap: 12px; padding-top: 16px; border-top: 1px solid rgba(128,128,128,.25); }
.dsh-wr-page .dsh-wr-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.dsh-wr-page label { display: grid; gap: 6px; }
.dsh-wr-page label.dsh-wr-check { grid-auto-flow: column; justify-content: start; align-items: center; gap: 8px; }
.dsh-wr-page input[type=text], .dsh-wr-page input[type=number], .dsh-wr-page input[type=time] { box-sizing: border-box; width: 100%; min-height: 32px; padding: 5px 8px; border: 1px solid rgba(128,128,128,.4); border-radius: 6px; background: transparent; color: inherit; font: inherit; }
.dsh-wr-page input:focus { outline: none; border-color: #6b8cff; box-shadow: 0 0 0 2px rgba(107,140,255,.2); }
.dsh-wr-page input[type=checkbox] { width: 15px; height: 15px; accent-color: #6b8cff; }
.dsh-wr-page .dsh-wr-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dsh-wr-page .dsh-wr-actions button { min-height: 32px; padding: 5px 12px; border: 1px solid rgba(128,128,128,.4); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font: inherit; }
.dsh-wr-page .dsh-wr-actions button:disabled { opacity: .5; cursor: default; }
.dsh-wr-page .dsh-wr-actions button.dsh-wr-primary { color: #fff; background: #6b8cff; border-color: #6b8cff; }
.dsh-wr-page code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
@media (max-width: 600px) { .dsh-wr-page .dsh-wr-grid { grid-template-columns: 1fr; } }
`

    async function api(method, body) {
      const response = await fetch(`/water/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const envelope = await response.json()
      if (!envelope.ok) throw new Error(envelope.error?.message ?? 'request failed')
      return envelope.value
    }

    /** `mm:ss` for a remaining duration, clamped at zero. */
    function countdown(ms) {
      const total = Math.max(0, Math.round(ms / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${`${minutes}`.padStart(2, '0')}:${`${seconds}`.padStart(2, '0')}`
    }

    /** Short day label for one sparkline column, e.g. `09-17`. */
    function dayLabel(key) {
      return key.slice(5)
    }

    // --- Sidebar panel ------------------------------------------------------

    function createPanel() {
      return function WaterPanel({ wide }) {
        const [open, setOpen] = useState(false)
        const [status, setStatus] = useState(null)
        const [error, setError] = useState(null)
        const [busy, setBusy] = useState(false)
        const [now, setNow] = useState(() => Date.now())
        const [notice, setNotice] = useState('')
        const [notifyState, setNotifyState] = useState(() => {
          if (typeof Notification === 'undefined') return 'unsupported'
          return Notification.permission
        })
        const buttonRef = useRef(null)
        const panelRef = useRef(null)
        const [anchor, setAnchor] = useState(null)
        const lastSeq = useRef(null)

        const load = useCallback(async () => {
          try {
            const value = await api('status')
            setStatus(value)
            setError(null)
          } catch (failure) {
            setError(String(failure.message ?? failure))
          }
        }, [])

        // Initial load plus a slow poll; the countdown itself is local.
        useEffect(() => {
          void load()
          const timer = window.setInterval(() => { if (!document.hidden) void load() }, 15_000)
          document.addEventListener('visibilitychange', load)
          return () => {
            window.clearInterval(timer)
            document.removeEventListener('visibilitychange', load)
          }
        }, [load])

        // Local tick so the countdown moves every second between polls.
        useEffect(() => {
          const timer = window.setInterval(() => setNow(Date.now()), 1_000)
          return () => window.clearInterval(timer)
        }, [])

        // The host bumps `reminderSeq` when a reminder fires; mirror it into a
        // browser notification so the tab is a delivery channel of its own.
        useEffect(() => {
          if (status === null) return
          const seq = status.reminderSeq
          if (lastSeq.current === null) {
            lastSeq.current = seq
            return
          }
          if (seq <= lastSeq.current) return
          lastSeq.current = seq
          if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
          try {
            new Notification(t.title, { body: status.remainingMl === 0 ? t.done : `${t.today} ${status.todayMl}/${status.goalMl}${t.ml}`, tag: 'water-reminder' })
          } catch {
            // A notification failure must never break the panel.
          }
        }, [status])

        useEffect(() => {
          if (open && buttonRef.current !== null) {
            const box = buttonRef.current.getBoundingClientRect()
            setAnchor({ left: Math.max(8, box.left), bottom: window.innerHeight - box.top + 6 })
          }
        }, [open])

        useEffect(() => {
          if (!open) return undefined
          const close = (event) => {
            if (panelRef.current?.contains(event.target)) return
            if (buttonRef.current?.contains(event.target)) return
            setOpen(false)
          }
          const escape = (event) => { if (event.key === 'Escape') setOpen(false) }
          document.addEventListener('mousedown', close)
          document.addEventListener('keydown', escape)
          return () => {
            document.removeEventListener('mousedown', close)
            document.removeEventListener('keydown', escape)
          }
        }, [open])

        const act = (work) => async () => {
          setBusy(true)
          setNotice('')
          try {
            await work()
            await load()
          } catch (failure) {
            setError(String(failure.message ?? failure))
          } finally {
            setBusy(false)
          }
        }

        const logCup = act(async () => {
          const value = await api('drink', { ml: status?.cupMl })
          setNotice(`+${value.ml}${t.ml}`)
        })
        const snooze = act(async () => {
          await api('snooze', {})
          setNotice(t.snooze)
        })
        const remindNow = act(async () => {
          await api('remind-now', {})
        })
        const toggle = act(async () => {
          await api('control', { enabled: status === null ? true : !status.enabled })
        })
        const allowBrowserNotify = () => {
          if (typeof Notification === 'undefined') return
          void Notification.requestPermission().then(permission => {
            setNotifyState(permission)
            setNotice(permission === 'granted' ? t.browserGranted : t.browserDenied)
          })
        }

        const due = status?.nextDueAt == null ? null : Date.parse(status.nextDueAt)
        const remaining = due === null ? null : Math.max(0, due - now)
        const percent = status?.percent ?? 0
        const done = status !== null && status.remainingMl === 0
        const buttonLabel = status === null
          ? t.button
          : !status.enabled
            ? t.buttonPaused
            : remaining === null
              ? t.button
              : countdown(remaining)
        const weekMax = status === null
          ? 1
          : Math.max(status.goalMl, ...status.week.map(row => row.ml), 1)

        return h(React.Fragment, null,
          h('button', {
            ref: buttonRef,
            className: 'dsh-wr-button' + (status !== null && !status.enabled ? ' dsh-wr-button-off' : ''),
            title: t.title,
            'aria-expanded': open,
            onClick: () => setOpen(value => !value),
          }, done ? '✅' : status !== null && !status.enabled ? '💤' : '💧', buttonLabel),

          open && anchor !== null && h('div', {
            ref: panelRef,
            className: 'dsh-wr-panel',
            style: { left: `${anchor.left}px`, bottom: `${anchor.bottom}px` },
          },
            h('div', { className: 'dsh-wr-head' },
              h('span', null, t.title),
              h('button', { className: 'dsh-wr-icon-btn', title: t.refresh, disabled: busy, onClick: () => void load() }, '⟳'),
            ),
            h('div', { className: 'dsh-wr-body' },
              status === null && error === null && h('div', { className: 'dsh-wr-note' }, t.loading),
              error !== null && h('div', { className: 'dsh-wr-error' }, error),
              status !== null && h(React.Fragment, null,
                h('div', { className: 'dsh-wr-hero' },
                  h('span', { className: 'dsh-wr-big' }, `${status.todayMl}`),
                  h('span', { className: 'dsh-wr-unit' }, `/ ${status.goalMl}${t.ml}`),
                  h('span', { className: 'dsh-wr-sub' }, done ? t.done : `${t.remaining} ${status.remainingMl}${t.ml}`),
                ),
                h('div', { className: 'dsh-wr-track' },
                  h('div', {
                    className: 'dsh-wr-fill' + (done ? ' dsh-wr-fill-done' : ''),
                    style: { width: `${Math.max(2, percent)}%` },
                  }),
                ),
                h('div', { className: 'dsh-wr-stats' },
                  h('span', null, `${status.cups} ${t.cups}`),
                  h('span', null, `${t.streak} `, h('b', null, status.streakDays), ` ${t.days}`),
                  h('span', null, `${status.band.min}–${status.band.max}${t.minutes}`),
                ),
                h('div', { className: 'dsh-wr-next' },
                  h('span', null, t.next),
                  h('span', { className: 'dsh-wr-next-count' },
                    status.enabled
                      ? (remaining === null ? t.notScheduled : `${countdown(remaining)} · ${status.nextDueText}`)
                      : '—'),
                ),
                status.quiet.enabled && h('div', { className: 'dsh-wr-quiet' },
                  `${t.quiet} ${status.quiet.from}–${status.quiet.to}${status.inQuietHours ? ` · ${t.quietHint}` : ''}`),
                h('div', { className: 'dsh-wr-week' },
                  ...status.week.map((row, index) => h('div', {
                    key: row.key,
                    className: 'dsh-wr-bar' + (index === status.week.length - 1 ? ' dsh-wr-bar-today' : ''),
                    title: `${row.key}: ${row.ml}${t.ml}`,
                  },
                    h('i', { style: { height: `${Math.max(2, Math.round((row.ml / weekMax) * 100))}%` } }),
                    h('span', null, dayLabel(row.key)),
                  )),
                ),
                h('div', { className: 'dsh-wr-actions' },
                  h('button', { className: 'dsh-wr-primary', disabled: busy, onClick: () => void logCup() }, `+${status.cupMl}${t.ml} ${t.log}`),
                  h('button', { disabled: busy || !status.enabled, onClick: () => void snooze() }, t.snooze),
                ),
                h('div', { className: 'dsh-wr-actions' },
                  h('button', { disabled: busy, onClick: () => void remindNow() }, t.now),
                  h('button', { disabled: busy, onClick: () => void toggle() }, status.enabled ? t.pause : t.resume),
                ),
              ),
            ),
            h('div', { className: 'dsh-wr-foot' },
              notifyState === 'granted' || notifyState === 'unsupported'
                ? h('span', null, notifyState === 'granted' ? t.browserGranted : '')
                : h('button', {
                  className: 'dsh-wr-icon-btn',
                  style: { width: 'auto', padding: '0 6px' },
                  onClick: allowBrowserNotify,
                }, `🔔 ${t.browserNotify}`),
              h('span', { style: { marginLeft: 'auto' } }, notice),
            ),
          ),
        )
      }
    }

    // --- Settings page ------------------------------------------------------

    /** Flat form keys, grouped on save into the nested settings objects. */
    const SIMPLE_FIELDS = [
      'enabled',
      'intervalMinMinutes',
      'intervalMaxMinutes',
      'dailyGoalMl',
      'cupMl',
      'snoozeMinutes',
    ]
    const QUIET_FIELDS = ['quietEnabled', 'quietFrom', 'quietTo']
    const CHANNEL_FIELDS = ['notifyOs', 'notifyAgent', 'notifySound']

    // dsh >= 0.1.2-alpha.3 removed the browser `settingsScope` service; the
    // shared settings provider now exposes `configForms`. Adapt the scoped
    // face this page was written against (getSnapshot/set) onto it. The view
    // is cached per underlying snapshot so React's getSnapshot stays
    // reference-stable between changes.
    function bindSettingsScope(ctx, namespace) {
      const form = ctx.configForms.get(namespace)
      let lastSnap = null
      let view = null
      return {
        getSnapshot: () => {
          const snap = form.getSnapshot()
          if (snap !== lastSnap) {
            lastSnap = snap
            view = { status: snap.status, writable: snap.status === 'ready', value: snap.value }
          }
          return view
        },
        set: (path, value) => form.mutate([{ op: 'set', path: String(path).split('.'), value }]),
        unset: (path) => form.mutate([{ op: 'unset', path: String(path).split('.') }]),
      }
    }

    function createSettingsPage(ctx) {
      const scope = bindSettingsScope(ctx, NS)
      let staged = null
      const listeners = new Set()
      const emit = () => { for (const listener of listeners) listener() }
      const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }

      let lastSnapshot = null
      let cached = null
      const flatten = (snapshot) => {
        const value = snapshot.value ?? {}
        const quiet = value.quietHours ?? {}
        const notify = value.notify ?? {}
        return {
          enabled: value.enabled !== false,
          intervalMinMinutes: value.intervalMinMinutes ?? 40,
          intervalMaxMinutes: value.intervalMaxMinutes ?? 60,
          dailyGoalMl: value.dailyGoalMl ?? 2000,
          cupMl: value.cupMl ?? 250,
          snoozeMinutes: value.snoozeMinutes ?? 5,
          quietFrom: quiet.from ?? '22:00',
          quietTo: quiet.to ?? '08:00',
          notifyOs: notify.os !== false,
          notifyAgent: notify.agent !== false,
          notifySound: notify.sound !== false,
          promptSection: value.promptSection !== false,
          skill: value.skill !== false,
        }
      }
      const committed = () => {
        const snapshot = scope.getSnapshot()
        if (snapshot !== lastSnapshot) {
          lastSnapshot = snapshot
          cached = { status: snapshot.status, writable: snapshot.writable, value: flatten(snapshot) }
        }
        return cached
      }
      const state = () => staged ?? committed()
      const useState = () => React.useSyncExternalStore(subscribe, state, state)
      const change = (field, value) => {
        staged = { ...state(), value: { ...state().value, [field]: value } }
        emit()
      }
      const discard = () => { staged = null; emit() }
      const save = async () => {
        if (staged === null) return
        const current = committed()
        const next = staged.value
        const previous = current.value
        const writes = []
        for (const field of SIMPLE_FIELDS) {
          if (next[field] !== previous[field]) writes.push(scope.set(field, next[field]))
        }
        if (QUIET_FIELDS.some(field => next[field] !== previous[field])) {
          writes.push(scope.set('quietHours', { enabled: next.quietEnabled, from: next.quietFrom, to: next.quietTo }))
        }
        if (CHANNEL_FIELDS.some(field => next[field] !== previous[field])) {
          writes.push(scope.set('notify', { os: next.notifyOs, agent: next.notifyAgent, sound: next.notifySound }))
        }
        if (next.promptSection !== previous.promptSection) writes.push(scope.set('promptSection', next.promptSection))
        if (next.skill !== previous.skill) writes.push(scope.set('skill', next.skill))
        await Promise.all(writes)
        staged = null
        emit()
      }
      return { useState, change, discard, save }
    }

    function createSettingsCard(ctx) {
      const controller = createSettingsPage(ctx)

      const NumberField = ({ label, field, min, max, disabled }) => h('label', null, label,
        h('input', {
          type: 'number', min, max, disabled,
          value: `${controller.useState().value[field]}`,
          onChange: event => controller.change(field, Number(event.target.value)),
        }),
      )
      const CheckField = ({ label, field, disabled }) => h('label', { className: 'dsh-wr-check' },
        h('input', {
          type: 'checkbox', disabled, checked: controller.useState().value[field] === true,
          onChange: event => controller.change(field, event.target.checked),
        }),
        label,
      )

      return function WaterSettings() {
        const state = controller.useState()
        const [busy, setBusy] = useState(false)
        const [notice, setNotice] = useState('')
        if (state.status === 'loading') {
          return h('section', { className: 'dsh-wr-page' }, h('p', { className: 'dsh-wr-muted' }, t.loading))
        }
        if (state.status === 'unavailable') {
          return h('section', { className: 'dsh-wr-page' }, h('p', { className: 'dsh-wr-muted' }, t.unavailable))
        }
        const disabled = !state.writable || busy
        const save = () => {
          setBusy(true)
          setNotice('')
          controller.save()
            .then(() => setNotice(t.saved))
            .catch(failure => setNotice(String(failure.message ?? failure)))
            .finally(() => setBusy(false))
        }
        return h('section', { className: 'dsh-wr-page' },
          h('header', null,
            h('h2', null, t.settingsTitle),
            h('p', { className: 'dsh-wr-muted' }, t.settingsIntro),
          ),
          h('section', { className: 'dsh-wr-section' },
            h('h3', null, t.settingsSchedule),
            h(CheckField, { label: t.enabled, field: 'enabled', disabled }),
            h('div', { className: 'dsh-wr-grid' },
              h(NumberField, { label: t.intervalMin, field: 'intervalMinMinutes', min: 5, max: 720, disabled }),
              h(NumberField, { label: t.intervalMax, field: 'intervalMaxMinutes', min: 5, max: 720, disabled }),
              h(NumberField, { label: t.snoozeMinutes, field: 'snoozeMinutes', min: 1, max: 720, disabled }),
            ),
          ),
          h('section', { className: 'dsh-wr-section' },
            h('h3', null, t.settingsGoal),
            h('div', { className: 'dsh-wr-grid' },
              h(NumberField, { label: t.goalMl, field: 'dailyGoalMl', min: 200, max: 20_000, disabled }),
              h(NumberField, { label: t.cupMl, field: 'cupMl', min: 50, max: 2000, disabled }),
            ),
          ),
          h('section', { className: 'dsh-wr-section' },
            h('h3', null, t.settingsQuiet),
            h(CheckField, { label: t.quietEnabled, field: 'quietEnabled', disabled }),
            h('div', { className: 'dsh-wr-grid' },
              h('label', null, t.quietFrom,
                h('input', {
                  type: 'time', disabled, value: controller.useState().value.quietFrom,
                  onChange: event => controller.change('quietFrom', event.target.value),
                })),
              h('label', null, t.quietTo,
                h('input', {
                  type: 'time', disabled, value: controller.useState().value.quietTo,
                  onChange: event => controller.change('quietTo', event.target.value),
                })),
            ),
            h('p', { className: 'dsh-wr-muted' }, t.quietHint),
          ),
          h('section', { className: 'dsh-wr-section' },
            h('h3', null, t.settingsChannels),
            h(CheckField, { label: t.channelOs, field: 'notifyOs', disabled }),
            h(CheckField, { label: t.channelAgent, field: 'notifyAgent', disabled }),
            h(CheckField, { label: t.channelSound, field: 'notifySound', disabled }),
          ),
          h('section', { className: 'dsh-wr-section' },
            h('h3', null, t.settingsAdvanced),
            h(CheckField, { label: t.promptSection, field: 'promptSection', disabled }),
            h(CheckField, { label: t.skillToggle, field: 'skill', disabled }),
            h('p', { className: 'dsh-wr-muted' }, t.stateFile, ': ', h('code', null, '~/.dsh/water-reminder.json')),
            h('p', { className: 'dsh-wr-muted' }, t.restartHint),
          ),
          h('div', { className: 'dsh-wr-actions' },
            h('button', { type: 'button', className: 'dsh-wr-primary', disabled, onClick: save }, busy ? '…' : t.save),
            h('button', { type: 'button', disabled, onClick: controller.discard }, t.discard),
            notice !== '' && h('span', { className: 'dsh-wr-muted', role: 'status' }, notice),
          ),
          !state.writable && h('p', { className: 'dsh-wr-muted' }, t.readonly),
        )
      }
    }

    function apply(ctx) {
      const style = document.createElement('style')
      style.textContent = STYLE
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'water-reminder: styles')

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: NS,
        order: 160,
      }, createPanel()))

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 32,
        label: () => t.settingsTitle,
        locale: 'settings.waterReminder',
        inject: () => ({}),
      }, createSettingsCard(ctx)))
    }

    exports.inject = ['slots', 'configForms']
    exports.apply = apply
    return module.exports
  },
})
