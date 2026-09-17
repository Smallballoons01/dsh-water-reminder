/**
 * Unit tests for the pure hydration domain logic.
 *
 * Every case here is timezone-sensitive by construction: the schedule and the
 * intake log are local-clock concepts, so the fixtures build dates with the
 * multi-argument `Date` constructor (local time) instead of ISO strings.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampNumber,
  clockText,
  createState,
  dailySeries,
  dayKey,
  drawDelayMs,
  goalStreak,
  inQuietHours,
  intakeOn,
  logDrink,
  nextFireAt,
  normalizeBand,
  normalizeConfig,
  normalizeQuiet,
  normalizeState,
  parseClock,
  randomInt,
  reminderSentence,
  resolveEffective,
  summarize,
} from '../hydration.js'

const at = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute, 0, 0)

test('clampNumber rounds, clamps, and falls back on non-numbers', () => {
  assert.equal(clampNumber(42.4, 0, 100, 10), 42)
  assert.equal(clampNumber(150, 0, 100, 10), 100)
  assert.equal(clampNumber(-5, 0, 100, 10), 0)
  assert.equal(clampNumber('60', 0, 100, 10), 60)
  assert.equal(clampNumber(undefined, 0, 100, 10), 10)
  assert.equal(clampNumber(Number.NaN, 0, 100, 10), 10)
})

test('normalizeBand orders endpoints and enforces the floor and ceiling', () => {
  assert.deepEqual(normalizeBand(40, 60), { min: 40, max: 60 })
  assert.deepEqual(normalizeBand(60, 40), { min: 40, max: 60 })
  assert.deepEqual(normalizeBand(1, 2), { min: 5, max: 5 })
  assert.deepEqual(normalizeBand(0, 5000), { min: 5, max: 720 })
  assert.deepEqual(normalizeBand(undefined, undefined), { min: 40, max: 60 })
  assert.deepEqual(normalizeBand(45, 45), { min: 45, max: 45 })
})

test('randomInt stays inside its inclusive bounds', () => {
  assert.equal(randomInt(40, 60, () => 0), 40)
  assert.equal(randomInt(40, 60, () => 0.999999), 60)
  assert.equal(randomInt(40, 60, () => 0.5), 50)
  assert.equal(randomInt(7, 7, () => 0.9), 7)
  // A hostile rng cannot push the draw out of range.
  assert.equal(randomInt(40, 60, () => 5), 60)
  assert.equal(randomInt(40, 60, () => -1), 40)
})

test('drawDelayMs converts the drawn minutes to milliseconds', () => {
  assert.equal(drawDelayMs({ min: 40, max: 60 }, () => 0), 40 * 60_000)
  assert.equal(drawDelayMs({ min: 40, max: 60 }, () => 0.999999), 60 * 60_000)
})

test('parseClock accepts padded and unpadded times and rejects junk', () => {
  assert.equal(parseClock('22:00'), 1320)
  assert.equal(parseClock('8:05'), 485)
  assert.equal(parseClock(' 09:30 '), 570)
  assert.equal(parseClock('24:00'), undefined)
  assert.equal(parseClock('12:60'), undefined)
  assert.equal(parseClock('noon'), undefined)
  assert.equal(parseClock(undefined), undefined)
})

test('normalizeQuiet falls back to the default window and disables unusable input', () => {
  const defaults = normalizeQuiet(undefined)
  assert.equal(defaults.from, '22:00')
  assert.equal(defaults.to, '08:00')
  assert.equal(defaults.enabled, false)

  assert.equal(normalizeQuiet({ enabled: true, from: '23:00', to: '07:00' }).enabled, true)
  // Equal endpoints mean an empty window, not a 24-hour silence.
  assert.equal(normalizeQuiet({ enabled: true, from: '09:00', to: '09:00' }).enabled, false)
  assert.equal(normalizeQuiet({ enabled: true, from: 'oops', to: '07:00' }).enabled, false)
})

test('inQuietHours handles a window that wraps past midnight', () => {
  const quiet = normalizeQuiet({ enabled: true, from: '22:00', to: '08:00' })
  assert.equal(inQuietHours(at(2026, 9, 17, 23, 0), quiet), true)
  assert.equal(inQuietHours(at(2026, 9, 17, 7, 59), quiet), true)
  assert.equal(inQuietHours(at(2026, 9, 17, 8, 0), quiet), false)
  assert.equal(inQuietHours(at(2026, 9, 17, 12, 0), quiet), false)
  assert.equal(inQuietHours(at(2026, 9, 17, 21, 59), quiet), false)

  const daytime = normalizeQuiet({ enabled: true, from: '13:00', to: '14:00' })
  assert.equal(inQuietHours(at(2026, 9, 17, 13, 30), daytime), true)
  assert.equal(inQuietHours(at(2026, 9, 17, 15, 0), daytime), false)

  const off = normalizeQuiet({ enabled: false, from: '22:00', to: '08:00' })
  assert.equal(inQuietHours(at(2026, 9, 17, 23, 30), off), false)
})

test('nextFireAt draws from the band and always moves forward', () => {
  const quiet = normalizeQuiet({ enabled: false })
  const now = at(2026, 9, 17, 10, 0)
  assert.deepEqual(nextFireAt(now, { band: { min: 40, max: 60 }, quiet, rng: () => 0 }), at(2026, 9, 17, 10, 40))
  assert.deepEqual(nextFireAt(now, { band: { min: 40, max: 60 }, quiet, rng: () => 0.999999 }), at(2026, 9, 17, 11, 0))
})

test('nextFireAt pushes a draw inside the quiet window to the window end', () => {
  const quiet = normalizeQuiet({ enabled: true, from: '22:00', to: '08:00' })
  const due = nextFireAt(at(2026, 9, 17, 21, 30), { band: { min: 40, max: 40 }, quiet, rng: () => 0 })
  assert.deepEqual(due, at(2026, 9, 18, 8, 0))
  assert.equal(inQuietHours(due, quiet), false)
})

test('dayKey and clockText use the local calendar', () => {
  const instant = at(2026, 9, 7, 6, 5)
  assert.equal(dayKey(instant), '2026-09-07')
  assert.equal(clockText(instant), '06:05')
  assert.equal(clockText(at(2026, 9, 7, 23, 59)), '23:59')
})

test('normalizeState drops unrecognized input and keeps valid history', () => {
  const fresh = normalizeState(undefined)
  assert.deepEqual(fresh.drinks, [])
  assert.equal(fresh.enabled, null)
  assert.equal(fresh.reminderSeq, 0)
  assert.deepEqual(fresh.stats, { reminders: 0, drinks: 0, snoozes: 0 })

  const restored = normalizeState({
    version: 99,
    drinks: [
      { at: '2026-09-17T02:00:00.000Z', ml: 300 },
      { at: '2026-09-17T03:00:00.000Z', ml: 250, note: 'coffee' },
      { at: 'not-a-date', ml: 250 },
      { ml: 250 },
    ],
    enabled: false,
    band: { min: 90, max: 60 },
    goalMl: 1500,
    reminderSeq: 4,
    stats: { reminders: 2 },
    bodyWeightKg: 68,
  })
  assert.equal(restored.drinks.length, 2)
  assert.equal(restored.drinks[1].note, 'coffee')
  assert.deepEqual(restored.band, { min: 60, max: 90 })
  assert.equal(restored.goalMl, 1500)
  assert.equal(restored.enabled, false)
  assert.equal(restored.stats.reminders, 2)
  assert.equal(restored.stats.drinks, 0)
  assert.equal(restored.bodyWeightKg, 68)
})

test('logDrink appends, stamps, and prunes the retention window', () => {
  const now = at(2026, 9, 17, 10, 0)
  const stale = { at: at(2025, 1, 1, 10, 0).toISOString(), ml: 250 }
  const first = logDrink({ ...createState(), drinks: [stale] }, { ml: 200, at: now })
  assert.equal(first.entry.ml, 200)
  assert.equal(first.state.drinks.length, 1)
  assert.equal(first.state.drinks[0].at, now.toISOString())
  assert.equal(first.state.stats.drinks, 1)

  const second = logDrink(first.state, { ml: 5000, at: now, note: 'after run' })
  assert.equal(second.state.drinks[1].ml, 5000)
  assert.equal(second.state.drinks[1].note, 'after run')
})

test('normalizeConfig completes a partial configuration', () => {
  const empty = normalizeConfig({})
  assert.equal(empty.enabled, true)
  assert.equal(empty.intervalMinMinutes, 40)
  assert.equal(empty.intervalMaxMinutes, 60)
  assert.equal(empty.dailyGoalMl, 2000)
  assert.equal(empty.cupMl, 250)
  assert.equal(empty.snoozeMinutes, 5)
  assert.deepEqual(empty.notify, { os: true, agent: true, sound: true })
  assert.equal(empty.quietHours.enabled, false)
  assert.equal(empty.stateFile, undefined)

  const custom = normalizeConfig({
    enabled: false,
    intervalMinMinutes: 900,
    cupMl: 10,
    notify: { sound: false },
    quietHours: { enabled: true, from: '23:30', to: '07:15' },
    stateFile: '/tmp/water.json',
  })
  assert.equal(custom.enabled, false)
  assert.equal(custom.intervalMinMinutes, 720)
  assert.equal(custom.cupMl, 50)
  assert.deepEqual(custom.notify, { os: true, agent: true, sound: false })
  assert.equal(custom.quietHours.from, '23:30')
  assert.equal(custom.stateFile, '/tmp/water.json')
})

test('resolveEffective lets persisted runtime overrides win over configuration', () => {
  const config = normalizeConfig({ enabled: true, intervalMinMinutes: 40, intervalMaxMinutes: 60, dailyGoalMl: 2000 })
  const base = resolveEffective(config, createState())
  assert.equal(base.enabled, true)
  assert.deepEqual(base.band, { min: 40, max: 60 })
  assert.equal(base.goalMl, 2000)

  const override = resolveEffective(config, { ...createState(), enabled: false, band: { min: 90, max: 120 }, goalMl: 1500 })
  assert.equal(override.enabled, false)
  assert.deepEqual(override.band, { min: 90, max: 120 })
  assert.equal(override.goalMl, 1500)
})

test('intakeOn totals one local day only', () => {
  const drinks = [
    { at: at(2026, 9, 17, 9, 0).toISOString(), ml: 250 },
    { at: at(2026, 9, 17, 14, 0).toISOString(), ml: 300 },
    { at: at(2026, 9, 16, 14, 0).toISOString(), ml: 900 },
  ]
  assert.equal(intakeOn(drinks, '2026-09-17'), 550)
  assert.equal(intakeOn(drinks, '2026-09-16'), 900)
  assert.equal(intakeOn(drinks, '2026-09-15'), 0)
})

test('goalStreak counts through today and tolerates an unfinished today', () => {
  const goalMl = 1000
  const now = at(2026, 9, 17, 20, 0)
  const drinks = [
    { at: at(2026, 9, 17, 9, 0).toISOString(), ml: 1000 },
    { at: at(2026, 9, 16, 9, 0).toISOString(), ml: 1200 },
    { at: at(2026, 9, 15, 9, 0).toISOString(), ml: 1000 },
    { at: at(2026, 9, 14, 9, 0).toISOString(), ml: 400 },
  ]
  assert.equal(goalStreak(drinks, now, goalMl), 3)

  // Today not met yet: yesterday still anchors the streak.
  const unfinished = [{ at: at(2026, 9, 16, 9, 0).toISOString(), ml: 1200 }]
  assert.equal(goalStreak(unfinished, now, goalMl), 1)

  // A skipped yesterday breaks it.
  assert.equal(goalStreak([{ at: at(2026, 9, 14, 9, 0).toISOString(), ml: 1200 }], now, goalMl), 0)
})

test('dailySeries returns the rolling window with today last', () => {
  const now = at(2026, 9, 17, 12, 0)
  const drinks = [{ at: at(2026, 9, 17, 9, 0).toISOString(), ml: 250 }]
  const week = dailySeries(drinks, now, 7)
  assert.equal(week.length, 7)
  assert.equal(week[0].key, '2026-09-11')
  assert.equal(week[6].key, '2026-09-17')
  assert.equal(week[6].ml, 250)
  assert.equal(week[5].ml, 0)
})

test('summarize caps the percentage and floors the remainder', () => {
  const config = normalizeConfig({ dailyGoalMl: 1000, cupMl: 250 })
  const now = at(2026, 9, 17, 15, 30)
  const state = {
    ...createState(),
    drinks: [
      { at: at(2026, 9, 17, 9, 0).toISOString(), ml: 600 },
      { at: at(2026, 9, 17, 14, 0).toISOString(), ml: 700 },
    ],
    nextDueAt: at(2026, 9, 17, 16, 5).toISOString(),
  }
  const status = summarize(state, now, config)
  assert.equal(status.todayMl, 1300)
  assert.equal(status.percent, 100)
  assert.equal(status.remainingMl, 0)
  assert.equal(status.cups, 2)
  assert.equal(status.lastDrinkText, '14:00')
  assert.equal(status.nextDueText, '16:05')
  assert.equal(status.minutesUntilNext, 35)
  assert.equal(status.week.length, 7)
})

test('summarize reports no schedule while reminders are off', () => {
  const config = normalizeConfig({ enabled: false })
  const state = { ...createState(), nextDueAt: at(2026, 9, 17, 16, 5).toISOString() }
  const status = summarize(state, at(2026, 9, 17, 15, 30), config)
  assert.equal(status.enabled, false)
  assert.equal(status.nextDueAt, null)
  assert.equal(status.minutesUntilNext, null)
})

test('reminderSentence reflects how much is left', () => {
  const config = normalizeConfig({ dailyGoalMl: 2000, cupMl: 250 })
  const now = at(2026, 9, 17, 15, 0)
  assert.match(reminderSentence(summarize(createState(), now, config)), /今天还一口没喝/)
  const partial = { ...createState(), drinks: [{ at: at(2026, 9, 17, 9, 0).toISOString(), ml: 750 }] }
  assert.match(reminderSentence(summarize(partial, now, config)), /已喝 750ml/)
  const done = { ...createState(), drinks: [{ at: at(2026, 9, 17, 9, 0).toISOString(), ml: 2000 }] }
  assert.match(reminderSentence(summarize(done, now, config)), /目标已达成/)
})
