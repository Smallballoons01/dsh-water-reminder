/**
 * @dsh-plugin/water-reminder — host half.
 *
 * A hydration reminder for people who forget to drink while they are deep in
 * work. The plugin owns one timer and delivers each reminder through three
 * independent channels, so missing one still leaves two:
 *
 * 1. **Native OS notification** — raised through `ctx.subprocess` with a
 *    per-platform notifier, so it lands even when the browser is behind other
 *    windows.
 * 2. **Agent nudge** — a plugin-sourced message injected into every live root
 *    session, which makes the assistant say one short line in the conversation.
 * 3. **Browser notification** — the web half watches `reminderSeq` over the
 *    `/water/api` routes and raises a page notification of its own.
 *
 * The default rhythm draws a fresh interval from 40–60 minutes on every
 * reminder, because a perfectly regular timer is what teaches humans to ignore
 * it. Configuration (band, goal, cup size, quiet hours, channels) resolves
 * through the settings page; runtime overrides set by the tools or the panel
 * are persisted alongside the intake log.
 *
 * @module @dsh-plugin/water-reminder
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  clampNumber,
  clockText,
  createState,
  logDrink,
  nextFireAt,
  normalizeBand,
  normalizeConfig,
  normalizeState,
  reminderSentence,
  resolveEffective,
  summarize,
} from './hydration.js'
import { buildNotificationCommand, NOTIFICATION_SOURCE } from './notify.js'
import { SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE, skillBody } from './skill.js'

export const name = 'water-reminder'
export const inject = ['tools']

/** Settings namespace; the join key between the host half and the settings card. */
export const SETTINGS_NS = 'water-reminder'

/** HTTP prefix the web half's panel and card talk to. */
const API_PREFIX = '/water/api'

/** Largest request body the panel's routes accept. */
const MAX_BODY_BYTES = 32 * 1024

/** Default state file, beside the rest of the harness's per-user data. */
function defaultStatePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'water-reminder.json')
}

const quietSchema = z.object({
  enabled: z.boolean().default(false),
  from: z.string().default('22:00'),
  to: z.string().default('08:00'),
})

const notifySchema = z.object({
  os: z.boolean().default(true),
  agent: z.boolean().default(true),
  sound: z.boolean().default(true),
})

/** Schemastery configuration for the plugin. */
export const Config = z.object({
  /** Whether the reminder loop runs at start-up. Overridable at runtime. */
  enabled: z.boolean().default(true).volatile(),
  /** Lower bound of the random reminder interval, in minutes. */
  intervalMinMinutes: z.number().default(40).volatile(),
  /** Upper bound of the random reminder interval, in minutes. */
  intervalMaxMinutes: z.number().default(60).volatile(),
  /** Daily intake goal in milliliters. */
  dailyGoalMl: z.number().default(2000).volatile(),
  /** Milliliters recorded for one "I drank a cup" event. */
  cupMl: z.number().default(250).volatile(),
  /** Minutes \`water_snooze\` defers by when no explicit delay is given. */
  snoozeMinutes: z.number().default(5).volatile(),
  /** Local-time window in which reminders are held back. */
  quietHours: quietSchema.volatile(),
  /** Delivery channels. */
  notify: notifySchema.volatile(),
  /** Absolute path of the persisted state file. Defaults to \`$DSH_HOME/water-reminder.json\`. */
  stateFile: z.string(),
  /** Whether to expose a system-prompt section describing the reminder loop. */
  promptSection: z.boolean().default(true).volatile(),
  /** Whether to register the embedded \`hydration-coach\` skill. */
  skill: z.boolean().default(true).volatile(),
})
/**
 * Resolve the boot-time config's volatile references once: volatile Config
 * fields arrive as stable refs whose `.get()` follows hot reloads, and every
 * read below wants one plain snapshot.
 * @param config Validated plugin config.
 */
function unwrapVolatileConfig(config) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]))
}


const PROMPT_SECTION = `Hydration reminders (water-reminder plugin):
- A background loop reminds the user to drink water every 40-60 minutes (randomized) while this session is live. It arrives as a plugin message prefixed \`[water-reminder]\`.
- When that message arrives, reply with ONE short line reminding the user to drink water, then continue the current task. Never start a new task or a health lecture because of it.
- When the user says they drank water, call \`water_log\`. To postpone, call \`water_snooze\`. For progress or the next reminder time, call \`water_status\`.
- Load the \`hydration-coach\` skill for the full workflow before doing anything beyond those three calls.`

/** Output shape shared by every tool that reports the current progress. */
const PROGRESS_PROPERTIES = {
  todayMl: { type: 'number', required: true },
  goalMl: { type: 'number', required: true },
  percent: { type: 'number', required: true },
  cups: { type: 'number', required: true },
  remainingMl: { type: 'number', required: true },
  streakDays: { type: 'number', required: true },
}

/**
 * Compact one-line week series for a tool result.
 * @param week - `{ key, ml }[]` rows.
 * @returns the rendering string.
 */
function renderWeek(week) {
  return week.map(row => `${row.key.slice(5)}:${row.ml}`).join(' ')
}

/**
 * The plain, null-free shape tools return for the current progress.
 * @param status - a {@link summarize} snapshot.
 * @returns the flat progress object.
 */
function progressOf(status) {
  return {
    todayMl: status.todayMl,
    goalMl: status.goalMl,
    percent: status.percent,
    cups: status.cups,
    remainingMl: status.remainingMl,
    streakDays: status.streakDays,
  }
}

/** Read one JSON request body, capped. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

/** Answer the panel's routes with the shared envelope. */
function respond(res, status, envelope) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/**
 * Whether a request came from another site.
 *
 * These routes are not behind the harness's own `/api` browser-trust fence, and
 * the mutating methods here are reachable with a *simple* cross-origin POST
 * (the handler accepts a `text/plain` body that happens to parse as JSON), so
 * any page the user visits could otherwise log drinks or pause the reminder
 * loop. Requiring a same-origin `Origin` — or none at all, as a CLI client
 * sends — closes that without needing a token.
 * @param req - the incoming request.
 * @returns whether the request should be refused as cross-site.
 */
function crossSiteRequest(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return false
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return true
  try {
    return new URL(origin).host !== host
  } catch {
    // An unparseable origin (including the literal "null" a sandboxed document
    // sends) is not something a same-origin caller produces.
    return true
  }
}

/**
 * Register the plugin.
 * @param ctx - the host context.
 * @param config - the resolved composition configuration.
 */
export function apply(ctx, config) {
  // Normalize once at the boundary: the composition entry, the settings
  // document, and the schema defaults may each omit fields, so everything
  // below reads a complete object.
  let current = normalizeConfig(unwrapVolatileConfig(config))
  let source = () => current

  const runtime = {
    /** Persisted state; replaced wholesale by every mutation. */
    state: createState(),
    /** Pending `setTimeout` handle for the next reminder. */
    timer: undefined,
    /** Live root agents that receive the in-conversation nudge. */
    agents: new Set(),
    /** Serializes state writes so two mutations cannot interleave. */
    writes: Promise.resolve(),
    /** Set once the composition unloads; start-up work checks it before acting. */
    disposed: false,
  }

  const statePath = () => current.stateFile ?? defaultStatePath()

  /** Write the state file through a temp file so a crash cannot truncate it. */
  function save() {
    const payload = `${JSON.stringify(runtime.state, null, 2)}\n`
    const target = statePath()
    runtime.writes = runtime.writes
      .then(async () => {
        await mkdir(dirname(target), { recursive: true })
        const temporary = `${target}.tmp`
        await writeFile(temporary, payload, 'utf8')
        await rename(temporary, target)
      })
      .catch(error => ctx.logger.warn(`water-reminder: state was not saved: ${String(error)}`))
    return runtime.writes
  }

  /**
   * Load the state file once at start-up; a missing or corrupt file starts fresh.
   *
   * The promise is awaited by every tool and drained by the disposal barrier, so
   * a composition that unloads while this is still in flight cannot end up
   * arming a timer or writing a file after it was torn down.
   */
  const ready = (async () => {
    try {
      runtime.state = normalizeState(JSON.parse(await readFile(statePath(), 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        ctx.logger.warn(`water-reminder: state was not restored: ${String(error)}`)
      }
      runtime.state = createState()
    }
    if (!runtime.disposed) schedule()
  })()

  function clearTimer() {
    if (runtime.timer !== undefined) {
      clearTimeout(runtime.timer)
      runtime.timer = undefined
    }
  }

  /**
   * (Re)arm the reminder timer from the persisted state. A missing or stale
   * `nextDueAt` draws a fresh interval, so a restarted harness resumes on
   * rhythm instead of firing a backlog.
   */
  function schedule() {
    clearTimer()
    const effective = resolveEffective(current, runtime.state)
    if (!effective.enabled) {
      if (runtime.state.nextDueAt !== null) {
        runtime.state.nextDueAt = null
        void save()
      }
      return
    }
    const now = new Date()
    let due = runtime.state.nextDueAt === null ? undefined : new Date(runtime.state.nextDueAt)
    if (due === undefined || Number.isNaN(due.getTime()) || due.getTime() <= now.getTime()) {
      due = nextFireAt(now, { band: effective.band, quiet: effective.quiet })
      runtime.state.nextDueAt = due.toISOString()
      void save()
    }
    // The timer never holds the process open: a headless run must still exit.
    runtime.timer = setTimeout(() => {
      runtime.timer = undefined
      void fire().catch(error => ctx.logger.warn(`water-reminder: reminder failed: ${String(error)}`))
    }, Math.max(1000, due.getTime() - Date.now()))
    runtime.timer.unref?.()
  }

  /** Raise the native OS notification; failures degrade to a log line. */
  async function notifyOs(sentence, status) {
    if (!current.notify.os) return
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      ctx.logger.info(`water-reminder: no subprocess provider, OS notification skipped: ${sentence}`)
      return
    }
    const command = buildNotificationCommand(process.platform, {
      title: `${NOTIFICATION_SOURCE} · 喝水提醒 ${status.todayMl}/${status.goalMl}ml`,
      message: sentence,
      sound: current.notify.sound,
    })
    if (command === undefined) {
      ctx.logger.info(`water-reminder: no notifier for ${process.platform}: ${sentence}`)
      return
    }
    try {
      const handle = subprocess.spawn({
        argv: command.argv,
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8 * 1024 }, stderr: { maxBytes: 8 * 1024 } },
        graceMs: 3000,
      })
      const outcome = await handle.done
      if ((outcome.exitCode ?? 0) !== 0) {
        ctx.logger.warn(`water-reminder: ${command.kind} exited ${outcome.exitCode ?? outcome.signal}`)
      }
    } catch (error) {
      ctx.logger.warn(`water-reminder: OS notification failed: ${String(error)}`)
    }
  }

  /** Nudge every live root session with one line of context. */
  function notifyAgents(sentence, status) {
    if (!current.notify.agent) return
    const agents = ctx.get('agents')
    const roots = agents === undefined ? [...runtime.agents] : agents.roots().filter(agent => runtime.agents.has(agent))
    const text = `[water-reminder] ${sentence}\n`
      + `Today: ${status.todayMl}ml / ${status.goalMl}ml (${status.cups} cups). `
      + 'Reply with ONE short line reminding the user to drink water, placed at the start or end of your answer, '
      + 'then continue the current task. Do not start a new task because of this.'
    for (const agent of roots) {
      try {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin:water-reminder' },
        }))
      } catch {
        // The agent may have been disposed between the check and this nudge.
      }
    }
  }

  /** Deliver one reminder through every enabled channel and rearm the timer. */
  async function fire(options = {}) {
    const effective = resolveEffective(current, runtime.state)
    if (!effective.enabled && options.force !== true) {
      schedule()
      return undefined
    }
    const now = new Date()
    const status = summarize(runtime.state, now, current)
    const sentence = reminderSentence(status)
    runtime.state.lastReminderAt = now.toISOString()
    runtime.state.reminderSeq += 1
    runtime.state.stats.reminders += 1
    const after = summarize(runtime.state, now, current)
    await Promise.allSettled([notifyOs(sentence, after), Promise.resolve(notifyAgents(sentence, after))])
    await save()
    schedule()
    return { sentence, status: after }
  }

  // --- Agent tracking -----------------------------------------------------

  ctx.on('agent/created', ({ agent }) => {
    runtime.agents.add(agent)
    agent.ctx.effect(() => () => {
      runtime.agents.delete(agent)
    }, 'water-reminder: stop nudging a disposed agent')
  })

  // --- Tools --------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'water_status',
    description:
      'Report the hydration state: today\'s intake against the goal, cup count, goal streak, the reminder interval band, '
      + 'quiet hours, and when the next reminder fires. Use before answering any "how much water today" question.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true },
          today: { type: 'string', required: true },
          ...PROGRESS_PROPERTIES,
          cupMl: { type: 'number', required: true },
          intervalMinMinutes: { type: 'number', required: true },
          intervalMaxMinutes: { type: 'number', required: true },
          nextDueText: { type: 'string', required: true },
          minutesUntilNext: { type: 'number', required: true },
          lastDrinkText: { type: 'string', required: true },
          quietText: { type: 'string', required: true },
          inQuietHours: { type: 'boolean', required: true },
          weekText: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Water reminder: ${value.enabled ? 'on' : 'off'}`,
          `Today: ${value.todayMl}ml / ${value.goalMl}ml (${value.percent}%, ${value.cups} cups @${value.cupMl}ml), remaining ${value.remainingMl}ml`,
          `Streak: ${value.streakDays}d · Interval: ${value.intervalMinMinutes}-${value.intervalMaxMinutes}min · ${value.quietText}`,
          value.nextDueText === '' ? 'Next reminder: not scheduled' : `Next reminder: ${value.nextDueText} (in ${value.minutesUntilNext} min)`,
          value.lastDrinkText === '' ? 'Last drink: none recorded' : `Last drink: ${value.lastDrinkText}`,
          `Last 7 days (ml): ${value.weekText}`,
        ].join('\n'),
      }],
    },
    async execute() {
      await ready
      const status = summarize(runtime.state, new Date(), current)
      return {
        enabled: status.enabled,
        today: status.today,
        ...progressOf(status),
        cupMl: status.cupMl,
        intervalMinMinutes: status.band.min,
        intervalMaxMinutes: status.band.max,
        nextDueText: status.nextDueText ?? '',
        minutesUntilNext: status.minutesUntilNext ?? 0,
        lastDrinkText: status.lastDrinkText ?? '',
        quietText: status.quiet.enabled ? `${status.quiet.from}-${status.quiet.to}` : 'none',
        inQuietHours: status.inQuietHours,
        weekText: renderWeek(status.week),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Check hydration status', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'water_log',
    description:
      'Record one drink in the intake log. Defaults to the configured cup size (usually 250ml). '
      + 'Call it whenever the user says they drank water; the log is append-only.',
    parameters: {
      milliliters: {
        type: 'number',
        description: 'Volume drunk in milliliters. Defaults to the configured cup size.',
      },
      note: {
        type: 'string',
        description: 'Optional free-text note stored with the entry, e.g. "coffee" or "after run".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ml: { type: 'number', required: true },
          goalReached: { type: 'boolean', required: true },
          ...PROGRESS_PROPERTIES,
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Logged ${value.ml}ml — today ${value.todayMl}ml / ${value.goalMl}ml (${value.percent}%, ${value.cups} cups). ${value.message}`,
      }],
    },
    async execute(args) {
      await ready
      const effective = resolveEffective(current, runtime.state)
      const ml = clampNumber(args.milliliters ?? effective.cupMl, 1, 5000, effective.cupMl)
      const result = logDrink(runtime.state, { ml, note: args.note })
      runtime.state = result.state
      await save()
      const status = summarize(runtime.state, new Date(), current)
      const message = status.remainingMl === 0
        ? `Goal reached — ${status.streakDays} day streak.`
        : `${status.remainingMl}ml to go.`
      return { ml: result.entry.ml, goalReached: status.remainingMl === 0, ...progressOf(status), message }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Log ${args.milliliters ?? 'one cup'} of water`,
      kind: 'other',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'water_snooze',
    description:
      'Postpone the next water reminder. Use it when the user asks for silence for a while or is clearly mid-task.',
    parameters: {
      minutes: {
        type: 'number',
        description: 'How long to defer. Defaults to the configured snooze window (usually 5 minutes).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          minutes: { type: 'number', required: true },
          nextDueText: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Snoozed for ${value.minutes} min; next reminder at ${value.nextDueText}.`,
      }],
    },
    async execute(args) {
      await ready
      const minutes = clampNumber(args.minutes ?? current.snoozeMinutes, 1, 720, current.snoozeMinutes)
      const due = new Date(Date.now() + minutes * 60_000)
      runtime.state.nextDueAt = due.toISOString()
      runtime.state.stats.snoozes += 1
      await save()
      schedule()
      return {
        minutes,
        nextDueText: clockText(due),
        message: `Reminders paused until ${clockText(due)}.`,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Snooze water reminder ${args.minutes ?? ''} min`.trim(),
      kind: 'other',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'water_control',
    description:
      'Control the reminder loop: start or stop it, change the random interval band, change the daily goal, fire one '
      + 'reminder immediately, or clear every runtime override back to the configured defaults.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'stop', 'set-band', 'set-goal', 'remind-now', 'reset'],
        description: 'Which control to apply.',
      },
      interval_min_minutes: {
        type: 'number',
        description: 'For set-band: lower bound of the interval window, in minutes.',
      },
      interval_max_minutes: {
        type: 'number',
        description: 'For set-band: upper bound of the interval window, in minutes.',
      },
      daily_goal_ml: {
        type: 'number',
        description: 'For set-goal: daily intake goal in milliliters.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
          intervalMinMinutes: { type: 'number', required: true },
          intervalMaxMinutes: { type: 'number', required: true },
          goalMl: { type: 'number', required: true },
          nextDueText: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      await ready
      switch (args.action) {
        case 'start':
          runtime.state.enabled = true
          break
        case 'stop':
          runtime.state.enabled = false
          break
        case 'set-band': {
          const base = resolveEffective(current, runtime.state).band
          runtime.state.band = normalizeBand(
            args.interval_min_minutes ?? base.min,
            args.interval_max_minutes ?? base.max,
          )
          break
        }
        case 'set-goal':
          runtime.state.goalMl = clampNumber(args.daily_goal_ml, 200, 20_000, resolveEffective(current, runtime.state).goalMl)
          break
        case 'reset':
          runtime.state.enabled = null
          runtime.state.band = null
          runtime.state.goalMl = null
          break
        case 'remind-now':
          await fire({ force: true })
          break
        default:
          throw new Error(`unknown action '${args.action}'`)
      }
      await save()
      schedule()
      const status = summarize(runtime.state, new Date(), current)
      const message = args.action === 'remind-now'
        ? `Reminder sent. Next one at ${status.nextDueText ?? 'a fresh interval'}.`
        : `Reminders ${status.enabled ? 'on' : 'off'} · interval ${status.band.min}-${status.band.max}min · goal ${status.goalMl}ml`
          + `${status.nextDueText === null ? '' : ` · next ${status.nextDueText}`}`
      return {
        action: args.action,
        enabled: status.enabled,
        intervalMinMinutes: status.band.min,
        intervalMaxMinutes: status.band.max,
        goalMl: status.goalMl,
        nextDueText: status.nextDueText ?? '',
        message,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Water reminder: ${args.action}`, kind: 'other' }),
  }))

  // --- Optional surfaces --------------------------------------------------

  // The prompt section mounts only where a system prompt is composed.
  if (current.promptSection !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: 'water-reminder',
        order: 160,
        text: PROMPT_SECTION,
      })
    })
  }

  // The embedded skill is the same instructions as skills/hydration-coach/SKILL.md;
  // registering it here means the model gets them with no filesystem skill root.
  if (current.skill !== false) {
    ctx.inject(['skills'], (skillCtx) => {
      ctx.effect(() => skillCtx.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        source: 'runtime',
        content: skillBody(),
      }), 'water-reminder: embedded hydration-coach skill')
    })
  }

  // The panel's data API loads only where a web server exists.
  ctx.inject(['webServer'], (webCtx) => {
    ctx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        const method = new URL(req.url ?? '/', 'http://localhost').pathname.slice(`${API_PREFIX}/`.length)
        try {
          if (crossSiteRequest(req)) {
            respond(res, 403, { ok: false, error: { code: 'cross-site', message: 'cross-site request refused' } })
            return
          }
          if (req.method !== 'POST') throw new Error('POST only')
          const body = await readBody(req)
          await ready
          switch (method) {
            case 'status':
              respond(res, 200, { ok: true, value: summarize(runtime.state, new Date(), current) })
              return
            case 'drink': {
              const effective = resolveEffective(current, runtime.state)
              const ml = clampNumber(body.ml ?? effective.cupMl, 1, 5000, effective.cupMl)
              const result = logDrink(runtime.state, { ml, note: body.note })
              runtime.state = result.state
              await save()
              respond(res, 200, { ok: true, value: { ml: result.entry.ml, status: summarize(runtime.state, new Date(), current) } })
              return
            }
            case 'snooze': {
              const minutes = clampNumber(body.minutes ?? current.snoozeMinutes, 1, 720, current.snoozeMinutes)
              runtime.state.nextDueAt = new Date(Date.now() + minutes * 60_000).toISOString()
              runtime.state.stats.snoozes += 1
              await save()
              schedule()
              respond(res, 200, { ok: true, value: { minutes, status: summarize(runtime.state, new Date(), current) } })
              return
            }
            case 'control': {
              const enabled = body.enabled !== false
              runtime.state.enabled = enabled
              await save()
              schedule()
              respond(res, 200, { ok: true, value: summarize(runtime.state, new Date(), current) })
              return
            }
            case 'remind-now': {
              const delivered = await fire({ force: true })
              respond(res, 200, {
                ok: true,
                value: { sentence: delivered?.sentence ?? '', status: summarize(runtime.state, new Date(), current) },
              })
              return
            }
            default:
              respond(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method '${method}'` } })
          }
        } catch (error) {
          respond(res, 200, { ok: false, error: { code: 'error', message: String(error?.message ?? error) } })
        }
      },
    }), 'water-reminder: /water/api routes')
  })

  // Settings-driven configuration (dsh >= 0.1.2-alpha.3): the page's writes
  // persist as volatile Config fields; the document-updated event follows
  // every accepted write, so `current` is re-read and the timer rearmed for a
  // band or quiet-hours change to take effect now.
  ctx.inject(['settings'], (settingsCtx) => {
    ctx.on('settings/document-updated', (ns) => {
      if (ns !== SETTINGS_NS) return
      const served = settingsCtx.settings.describe().find((row) => row.ns === SETTINGS_NS)?.value
      if (served === undefined) return
      source = () => normalizeConfig(served)
      current = source()
      schedule()
    })
  })

  // Disposal stops the timer, then waits for start-up to settle and for any
  // in-flight write. Both halves matter: without the start-up barrier a load
  // still in flight would queue a fresh write *after* the drain and touch the
  // disk once the plugin was already unloaded.
  ctx.effect(() => () => {
    runtime.disposed = true
    clearTimer()
    return ready.catch(() => {}).then(() => runtime.writes)
  }, 'water-reminder: reminder timer')
}
