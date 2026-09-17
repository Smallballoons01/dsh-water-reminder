/**
 * Pure hydration domain logic for @dsh-plugin/water-reminder.
 *
 * Everything here is a plain function over plain data: no timers, no
 * filesystem, no harness imports. The plugin's host half owns the clock and
 * the state file; this module owns the arithmetic, so the reminder schedule
 * and today's intake can be unit-tested without booting a composition.
 *
 * Vocabulary
 * - band: the random reminder interval window, `{ min, max }` in minutes.
 *   The default band is 40–60 minutes: every reminder is drawn fresh from the
 *   window, so the rhythm stays irregular instead of training the user to
 *   ignore a metronome.
 * - quiet: an optional local-time window when reminders are held back and
 *   resume at the window's end.
 * - drinks: the append-only intake log, one `{ at, ml }` entry per cup.
 *
 * @module water-reminder/hydration
 */

/** Schema version of the persisted state file. */
export const STATE_VERSION = 1

/** Hard floor for a reminder interval: below this, reminders nag. */
export const MIN_BAND_MINUTES = 5

/** Hard ceiling for a reminder interval: half a day. */
export const MAX_BAND_MINUTES = 720

/** Days of drink history kept in the state file. */
export const KEEP_DAYS = 90

const MINUTES_PER_DAY = 24 * 60

/**
 * Coerce an unknown value into a finite number inside `[min, max]`.
 * @param value - candidate value.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @param fallback - value used when the candidate is not a finite number.
 * @returns the clamped number.
 */
export function clampNumber(value, min, max, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * Normalize a reminder band: order the endpoints, enforce the floor and
 * ceiling, and reject a degenerate window.
 * @param minMinutes - requested lower bound.
 * @param maxMinutes - requested upper bound.
 * @returns a valid `{ min, max }` band with `min <= max`.
 */
export function normalizeBand(minMinutes, maxMinutes) {
  const lower = clampNumber(minMinutes, MIN_BAND_MINUTES, MAX_BAND_MINUTES, 40)
  const upper = clampNumber(maxMinutes, MIN_BAND_MINUTES, MAX_BAND_MINUTES, 60)
  return lower <= upper ? { min: lower, max: upper } : { min: upper, max: lower }
}

/**
 * Inclusive random integer in `[min, max]`.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @param rng - random source in `[0, 1)`; defaults to `Math.random`.
 * @returns the drawn integer.
 */
export function randomInt(min, max, rng = Math.random) {
  if (max <= min) return min
  const draw = Number(rng())
  // Clamp into `[0, 1)`, not `[0, 1]`: a source that returns exactly 1 (or more)
  // must still land on `max`, never one past it. `Math.random` itself never
  // reaches this clamp — its largest value is below `1 - Number.EPSILON` — so
  // the distribution is untouched.
  const unit = Number.isFinite(draw) ? Math.min(1 - Number.EPSILON, Math.max(0, draw)) : 0
  return min + Math.floor(unit * (max - min + 1))
}

/**
 * Draw the next reminder delay from a band, in milliseconds.
 * @param band - the `{ min, max }` minute window.
 * @param rng - random source.
 * @returns delay in milliseconds.
 */
export function drawDelayMs(band, rng = Math.random) {
  return randomInt(band.min, band.max, rng) * 60_000
}

/**
 * Parse a `HH:MM` clock string into minutes since local midnight.
 * @param text - candidate clock string.
 * @returns minutes since midnight, or `undefined` when unparseable.
 */
export function parseClock(text) {
  if (typeof text !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/**
 * Normalize a quiet-hours setting. A window whose endpoints are equal, or
 * whose endpoints cannot be parsed, is treated as disabled.
 * @param quiet - candidate `{ enabled, from, to }`.
 * @returns `{ enabled, from, to, fromMinutes, toMinutes }`.
 */
export function normalizeQuiet(quiet) {
  const candidate = quiet !== null && typeof quiet === 'object' ? quiet : {}
  const from = typeof candidate.from === 'string' ? candidate.from : '22:00'
  const to = typeof candidate.to === 'string' ? candidate.to : '08:00'
  const fromMinutes = parseClock(from)
  const toMinutes = parseClock(to)
  const usable = fromMinutes !== undefined && toMinutes !== undefined && fromMinutes !== toMinutes
  return {
    enabled: candidate.enabled === true && usable,
    from,
    to,
    fromMinutes: fromMinutes ?? parseClock('22:00'),
    toMinutes: toMinutes ?? parseClock('08:00'),
  }
}

/**
 * Minutes since local midnight for an instant, in the host's local zone.
 * @param date - the instant.
 * @returns minutes since local midnight.
 */
export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * Whether an instant falls inside the quiet window. The window may wrap past
 * midnight (`22:00` → `08:00`), which is the normal case.
 * @param date - the instant to test.
 * @param quiet - a normalized quiet setting.
 * @returns whether reminders are held back at that instant.
 */
export function inQuietHours(date, quiet) {
  if (!quiet.enabled) return false
  const now = minutesOfDay(date)
  const { fromMinutes, toMinutes } = quiet
  if (fromMinutes < toMinutes) return now >= fromMinutes && now < toMinutes
  return now >= fromMinutes || now < toMinutes
}

/**
 * The instant the quiet window ends at or after `date`, keeping the current
 * local time of day so the resume stays anchored to the user's clock.
 * @param date - the instant inside (or before) the window.
 * @param quiet - a normalized quiet setting.
 * @returns the resume instant.
 */
export function quietResumeAt(date, quiet) {
  const resume = new Date(date.getTime())
  resume.setHours(Math.floor(quiet.toMinutes / 60), quiet.toMinutes % 60, 0, 0)
  if (resume.getTime() <= date.getTime()) resume.setDate(resume.getDate() + 1)
  return resume
}

/**
 * The next reminder instant after `now`: a fresh draw from the band, pushed to
 * the end of the quiet window when the draw lands inside it.
 * @param now - the reference instant.
 * @param options - `{ band, quiet, rng }`.
 * @returns the next reminder instant, always strictly after `now`.
 */
export function nextFireAt(now, options) {
  const { band, quiet } = options
  const rng = options.rng ?? Math.random
  const candidate = new Date(now.getTime() + drawDelayMs(band, rng))
  return inQuietHours(candidate, quiet) ? quietResumeAt(candidate, quiet) : candidate
}

/**
 * Local calendar day key, `YYYY-MM-DD`.
 * @param date - the instant.
 * @returns the local day key.
 */
export function dayKey(date) {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Format an instant as a local `HH:MM` clock string.
 * @param date - the instant.
 * @returns the local clock string.
 */
export function clockText(date) {
  return `${`${date.getHours()}`.padStart(2, '0')}:${`${date.getMinutes()}`.padStart(2, '0')}`
}

/**
 * A fresh state record.
 * @returns the initial persisted state.
 */
export function createState() {
  return {
    version: STATE_VERSION,
    drinks: [],
    /** Runtime toggle; `null` means "follow the configured default". */
    enabled: null,
    /** Runtime band override; `null` means "follow the configured band". */
    band: null,
    /** Runtime daily-goal override in ml; `null` means "follow the configured goal". */
    goalMl: null,
    /** ISO instant of the pending reminder, or `null` when idle. */
    nextDueAt: null,
    /** ISO instant of the last delivered reminder. */
    lastReminderAt: null,
    /** Monotonic counter the browser half watches to raise its own notification. */
    reminderSeq: 0,
    stats: { reminders: 0, drinks: 0, snoozes: 0 },
    /** Optional personal fact used by the skill's coaching copy. */
    bodyWeightKg: null,
  }
}

/**
 * Rebuild a state record from untrusted persisted JSON, dropping anything the
 * current schema does not recognize instead of failing the whole load.
 * @param raw - parsed state file contents.
 * @returns a valid state record.
 */
export function normalizeState(raw) {
  const base = createState()
  if (raw === null || typeof raw !== 'object') return base
  const drinks = Array.isArray(raw.drinks)
    ? raw.drinks
      .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.at === 'string')
      .map(entry => ({
        at: entry.at,
        ml: clampNumber(entry.ml, 1, 5000, 250),
        ...(typeof entry.note === 'string' && entry.note !== '' ? { note: entry.note } : {}),
      }))
      .filter(entry => Number.isFinite(Date.parse(entry.at)))
    : []
  const band = raw.band !== null && typeof raw.band === 'object'
    ? normalizeBand(raw.band.min, raw.band.max)
    : null
  const stats = raw.stats !== null && typeof raw.stats === 'object' ? raw.stats : {}
  return {
    version: STATE_VERSION,
    drinks,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : null,
    band,
    goalMl: Number.isFinite(raw.goalMl) ? clampNumber(raw.goalMl, 200, 20_000, 2000) : null,
    nextDueAt: typeof raw.nextDueAt === 'string' && Number.isFinite(Date.parse(raw.nextDueAt)) ? raw.nextDueAt : null,
    lastReminderAt: typeof raw.lastReminderAt === 'string' && Number.isFinite(Date.parse(raw.lastReminderAt))
      ? raw.lastReminderAt
      : null,
    reminderSeq: clampNumber(raw.reminderSeq, 0, Number.MAX_SAFE_INTEGER, 0),
    stats: {
      reminders: clampNumber(stats.reminders, 0, Number.MAX_SAFE_INTEGER, 0),
      drinks: clampNumber(stats.drinks, 0, Number.MAX_SAFE_INTEGER, 0),
      snoozes: clampNumber(stats.snoozes, 0, Number.MAX_SAFE_INTEGER, 0),
    },
    bodyWeightKg: Number.isFinite(raw.bodyWeightKg) ? clampNumber(raw.bodyWeightKg, 20, 300, 60) : null,
  }
}

/**
 * Drop drink entries older than the retention window.
 * @param drinks - the intake log.
 * @param now - the reference instant.
 * @param keepDays - retention window in days.
 * @returns the pruned log.
 */
export function pruneDrinks(drinks, now, keepDays = KEEP_DAYS) {
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000
  return drinks.filter(entry => Date.parse(entry.at) >= cutoff)
}

/**
 * Record one drink. Returns a new state; the caller persists it.
 * @param state - the current state.
 * @param input - `{ ml, at, note }`; `at` defaults to now.
 * @returns `{ state, entry }` with the appended, pruned log.
 */
export function logDrink(state, input) {
  const at = input.at ?? new Date()
  const ml = clampNumber(input.ml, 1, 5000, 250)
  const entry = {
    at: at.toISOString(),
    ml,
    ...(typeof input.note === 'string' && input.note !== '' ? { note: input.note } : {}),
  }
  const drinks = pruneDrinks([...state.drinks, entry], at)
  return {
    state: { ...state, drinks, stats: { ...state.stats, drinks: state.stats.drinks + 1 } },
    entry,
  }
}

/**
 * Fill a partial configuration with defaults and clamp every numeric field.
 *
 * The composition entry, the settings document, and the schema defaults can
 * each omit fields, so the plugin normalizes once at the boundary and reads a
 * complete object everywhere else.
 * @param raw - the resolved configuration, possibly partial.
 * @returns a complete configuration object.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const quiet = input.quietHours !== null && typeof input.quietHours === 'object' ? input.quietHours : {}
  const notify = input.notify !== null && typeof input.notify === 'object' ? input.notify : {}
  return {
    enabled: input.enabled !== false,
    intervalMinMinutes: clampNumber(input.intervalMinMinutes, MIN_BAND_MINUTES, MAX_BAND_MINUTES, 40),
    intervalMaxMinutes: clampNumber(input.intervalMaxMinutes, MIN_BAND_MINUTES, MAX_BAND_MINUTES, 60),
    dailyGoalMl: clampNumber(input.dailyGoalMl, 200, 20_000, 2000),
    cupMl: clampNumber(input.cupMl, 50, 2000, 250),
    snoozeMinutes: clampNumber(input.snoozeMinutes, 1, 720, 5),
    quietHours: {
      enabled: quiet.enabled === true,
      from: typeof quiet.from === 'string' ? quiet.from : '22:00',
      to: typeof quiet.to === 'string' ? quiet.to : '08:00',
    },
    notify: {
      os: notify.os !== false,
      agent: notify.agent !== false,
      sound: notify.sound !== false,
    },
    stateFile: typeof input.stateFile === 'string' && input.stateFile !== '' ? input.stateFile : undefined,
    promptSection: input.promptSection !== false,
    skill: input.skill !== false,
  }
}

/**
 * Resolve the settings a run uses: persisted overrides win over configuration.
 * @param config - the resolved configuration.
 * @param state - the persisted state.
 * @returns the effective `{ enabled, band, goalMl, cupMl, quiet }`.
 */
export function resolveEffective(config, state) {
  return {
    enabled: state.enabled ?? config.enabled,
    band: state.band ?? normalizeBand(config.intervalMinMinutes, config.intervalMaxMinutes),
    goalMl: clampNumber(state.goalMl ?? config.dailyGoalMl, 200, 20_000, 2000),
    cupMl: clampNumber(config.cupMl, 50, 2000, 250),
    quiet: normalizeQuiet(config.quietHours),
  }
}

/**
 * Total intake for one local day.
 * @param drinks - the intake log.
 * @param key - the `YYYY-MM-DD` day key.
 * @returns milliliters consumed that day.
 */
export function intakeOn(drinks, key) {
  return drinks.reduce((total, entry) => (dayKey(new Date(entry.at)) === key ? total + entry.ml : total), 0)
}

/**
 * Consecutive days, ending today or yesterday, on which the goal was met.
 * Yesterday still counts as a live streak: the current day is not a miss until
 * it is over.
 * @param drinks - the intake log.
 * @param now - the reference instant.
 * @param goalMl - the daily goal.
 * @returns the streak length in days.
 */
export function goalStreak(drinks, now, goalMl) {
  const cursor = new Date(now.getTime())
  if (intakeOn(drinks, dayKey(cursor)) < goalMl) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (streak < KEEP_DAYS && intakeOn(drinks, dayKey(cursor)) >= goalMl) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/**
 * The rolling daily series used by the panel's sparkline.
 * @param drinks - the intake log.
 * @param now - the reference instant.
 * @param days - how many days back to include, today last.
 * @returns one `{ key, ml }` row per day.
 */
export function dailySeries(drinks, now, days = 7) {
  const rows = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const cursor = new Date(now.getTime())
    cursor.setDate(cursor.getDate() - offset)
    const key = dayKey(cursor)
    rows.push({ key, ml: intakeOn(drinks, key) })
  }
  return rows
}

/**
 * The full snapshot the tools, the HTTP API, and the panel all render.
 * @param state - the persisted state.
 * @param now - the reference instant.
 * @param config - the resolved configuration.
 * @returns the status snapshot.
 */
export function summarize(state, now, config) {
  const effective = resolveEffective(config, state)
  const today = dayKey(now)
  const todayMl = intakeOn(state.drinks, today)
  const last = state.drinks.length === 0 ? undefined : state.drinks[state.drinks.length - 1]
  const nextDueAt = effective.enabled && state.nextDueAt !== null ? new Date(state.nextDueAt) : undefined
  const minutesUntilNext = nextDueAt === undefined
    ? undefined
    : Math.max(0, Math.ceil((nextDueAt.getTime() - now.getTime()) / 60_000))
  return {
    enabled: effective.enabled,
    today,
    todayMl,
    goalMl: effective.goalMl,
    percent: Math.min(100, Math.round((todayMl / effective.goalMl) * 100)),
    cups: state.drinks.filter(entry => dayKey(new Date(entry.at)) === today).length,
    cupMl: effective.cupMl,
    remainingMl: Math.max(0, effective.goalMl - todayMl),
    streakDays: goalStreak(state.drinks, now, effective.goalMl),
    band: effective.band,
    quiet: { enabled: effective.quiet.enabled, from: effective.quiet.from, to: effective.quiet.to },
    nextDueAt: nextDueAt?.toISOString() ?? null,
    nextDueText: nextDueAt === undefined ? null : clockText(nextDueAt),
    minutesUntilNext: minutesUntilNext ?? null,
    lastDrinkAt: last?.at ?? null,
    lastDrinkText: last === undefined ? null : clockText(new Date(last.at)),
    lastReminderAt: state.lastReminderAt,
    inQuietHours: inQuietHours(now, effective.quiet),
    reminderSeq: state.reminderSeq,
    stats: state.stats,
    week: dailySeries(state.drinks, now, 7),
  }
}

/**
 * The one-line reminder the model speaks and the OS notification shows.
 * @param status - a {@link summarize} snapshot.
 * @returns the reminder sentence.
 */
export function reminderSentence(status) {
  if (status.remainingMl === 0) {
    return `今日目标已达成（${status.todayMl}ml）——再补一杯水也无妨，接着干活吧。`
  }
  if (status.todayMl === 0) {
    return `该喝水了：今天还一口没喝，先来 ${status.cupMl}ml（今日目标 ${status.goalMl}ml）。`
  }
  return `该喝水了：今天已喝 ${status.todayMl}ml（${status.cups} 杯），还差 ${status.remainingMl}ml 到 ${status.goalMl}ml。`
}
