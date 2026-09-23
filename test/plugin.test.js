/**
 * Behavior tests for the host half.
 *
 * A minimal fake context stands in for the composition: it records what the
 * plugin registers and lets each tool's `execute` run for real. Because
 * `defineTool` validates arguments and the runtime validates the returned value
 * against `output.schema`, these tests also assert that every tool's result
 * matches the schema it declares — the classic place a plugin silently rots.
 *
 * Teardown goes through the same `ctx.effect` disposers the harness uses, which
 * both clears the reminder timer and drains the pending state write; deleting
 * the temp directory while a write was still in flight is what made an earlier
 * version of this file flaky.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SKILL_NAME } from '../skill.js'

/**
 * The plugin module, or `undefined` when the DeepSeek Harness packages are not
 * installed. They are peer dependencies supplied by the host, and the versions
 * this plugin is developed against are not published to npm, so a fresh clone
 * has to fail soft: the tool tests below skip with an actionable message
 * instead of taking the whole suite down.
 */
const SKIP_REASON = 'requires the DeepSeek Harness packages (@deepseek-ai/dsh-tools, -llm, schemastery); see README -> Prerequisites'
const pluginModule = await import('../index.js').catch(() => undefined)

/** Recursively assert a value against a compiled JSON schema. */
function assertMatchesSchema(schema, value, path = 'value') {
  if (schema.type === 'object') {
    assert.equal(typeof value, 'object', `${path} should be an object`)
    assert.notEqual(value, null, `${path} should not be null`)
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      assert.ok(key in value, `${path}.${key} is declared required but missing from the result`)
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) assertMatchesSchema(child, value[key], `${path}.${key}`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(key in properties, `${path}.${key} is returned but not declared in output.schema`)
      }
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path} should be an array`)
    for (const [index, item] of value.entries()) assertMatchesSchema(schema.items ?? {}, item, `${path}[${index}]`)
    return
  }
  if (schema.type === 'number') assert.equal(typeof value, 'number', `${path} should be a number`)
  else if (schema.type === 'string') assert.equal(typeof value, 'string', `${path} should be a string`)
  else if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${path} should be a boolean`)
}

/** A fake host context that records registrations and answers every capability. */
function harness(options = {}) {
  harness.served = []
  const captured = {
    tools: [],
    sections: [],
    skills: [],
    routes: [],
    events: [],
    disposers: [],
    settings: undefined,
  }
  const services = {
    settings: { describe: () => harness.served },
    systemPrompt: { section: value => { captured.sections.push(value); return () => {} } },
    skills: { register: value => { captured.skills.push(value); return () => {} } },
    webServer: { register: value => { captured.routes.push(value); return () => {} } },
  }
  const ctx = {
    tools: { register: tool => captured.tools.push(tool) },
    on: (event, handler) => { captured.events.push([event, handler]); return () => {} },
    get: key => options.services?.[key],
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') captured.disposers.push(dispose)
      return dispose ?? (() => {})
    },
    logger: { warn: () => {}, info: () => {} },
    inject: (dependencies, callback) => {
      const available = {}
      for (const dependency of dependencies) {
        if (services[dependency] !== undefined) available[dependency] = services[dependency]
      }
      // Mirror cordis: the callback runs only when every dependency is present.
      if (Object.keys(available).length === dependencies.length) callback(available)
    },
    ...options.ctx,
  }
  return { ctx, captured }
}

/** A request stub that satisfies the prefix route's body reader. */
function request(method, url, body, headers = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
}

/** A response stub capturing status and JSON body. */
function response() {
  const captured = { status: undefined, body: undefined }
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(text) { captured.body = text },
  }
}

/** Apply the plugin against a fake host with a throwaway state file. */
if (pluginModule === undefined) {
  test('water-reminder tool tests', t => t.skip(SKIP_REASON))
} else {
  const { apply, Config, inject, name, SETTINGS_NS } = pluginModule

  async function setup(t, config = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'water-reminder-'))
    const stateFile = join(directory, 'state.json')
    const { ctx, captured } = harness()
    apply(ctx, { stateFile, ...config })
    const byName = Object.fromEntries(captured.tools.map(tool => [tool.name, tool]))
    t.after(async () => {
      for (const dispose of captured.disposers) await dispose()
      await rm(directory, { recursive: true, force: true })
    })
    return { directory, stateFile, captured, byName }
  }

  test('declares its plugin identity', () => {
    assert.equal(name, 'water-reminder')
    assert.deepEqual(inject, ['tools'])
  })

  test('registers the four hydration tools', async (t) => {
    const { byName } = await setup(t)
    assert.deepEqual(Object.keys(byName).sort(), ['water_control', 'water_log', 'water_snooze', 'water_status'])
    for (const tool of Object.values(byName)) {
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
      assert.ok(tool.description.length > 40, `${tool.name} needs a real description for the model`)
    }
  })

  test('follows settings writes through the document-updated event', async (t) => {
    const { captured, byName } = await setup(t)
    const listener = captured.events.find(([event]) => event === 'settings/document-updated')?.[1]
    assert.equal(typeof listener, 'function', 'the plugin follows the settings document')

    harness.served = [{ ns: SETTINGS_NS, value: { dailyGoalMl: 3000 } }]
    listener(SETTINGS_NS)
    assert.equal((await byName.water_status.execute({}, {})).goalMl, 3000)

    listener('some-other-namespace')
    assert.equal((await byName.water_status.execute({}, {})).goalMl, 3000, 'other namespaces do not reach the plugin')
  })

  test('registers the prompt section, the embedded skill, and the panel route', async (t) => {
    const { captured } = await setup(t)
    assert.equal(captured.sections.length, 1)
    assert.equal(captured.sections[0].name, 'water-reminder')
    assert.match(captured.sections[0].text, /water_log/)

    assert.equal(captured.skills.length, 1)
    assert.equal(captured.skills[0].name, SKILL_NAME)
    assert.equal(captured.skills[0].source, 'runtime')
    assert.match(captured.skills[0].content, /water_control/)

    assert.equal(captured.routes.length, 1)
    assert.equal(captured.routes[0].kind, 'prefix')
    assert.equal(captured.routes[0].path, '/water/api')

    assert.deepEqual(captured.events.map(([event]) => event), ['agent/created', 'settings/document-updated'])
  })

  test('optional surfaces stay absent when switched off', async (t) => {
    const { captured } = await setup(t, { promptSection: false, skill: false })
    assert.deepEqual(captured.sections, [])
    assert.deepEqual(captured.skills, [])
  })

  test('defaults the interval band to 40-60 minutes', async (t) => {
    const { byName } = await setup(t)
    const status = await byName.water_status.execute({}, {})
    assert.equal(status.intervalMinMinutes, 40)
    assert.equal(status.intervalMaxMinutes, 60)
    assert.equal(status.goalMl, 2000)
    assert.equal(status.cupMl, 250)
    assert.equal(status.enabled, true)
    assert.equal(status.todayMl, 0)
    assert.equal(status.percent, 0)
    assertMatchesSchema(byName.water_status.output.schema, status)
  })

  test('logs a drink, reports progress, and persists it', async (t) => {
    const { stateFile, byName } = await setup(t, { dailyGoalMl: 500, cupMl: 200 })
    const first = await byName.water_log.execute({}, {})
    assert.equal(first.ml, 200)
    assert.equal(first.todayMl, 200)
    assert.equal(first.remainingMl, 300)
    assert.equal(first.goalReached, false)
    assertMatchesSchema(byName.water_log.output.schema, first)

    const second = await byName.water_log.execute({ milliliters: 300, note: 'after run' }, {})
    assert.equal(second.todayMl, 500)
    assert.equal(second.goalReached, true)
    assert.equal(second.percent, 100)

    const persisted = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(persisted.drinks.length, 2)
    assert.equal(persisted.drinks[1].note, 'after run')
    assert.equal(persisted.stats.drinks, 2)

    const status = await byName.water_status.execute({}, {})
    assert.equal(status.todayMl, 500)
    assert.equal(status.cups, 2)
    // Reaching the goal today already counts as a live one-day streak.
    assert.equal(status.streakDays, 1)
  })

  test('snooze defers the pending reminder and counts the deferral', async (t) => {
    const { stateFile, byName } = await setup(t, { snoozeMinutes: 5 })
    await byName.water_status.execute({}, {})
    const snoozed = await byName.water_snooze.execute({ minutes: 10 }, {})
    assert.equal(snoozed.minutes, 10)
    assert.match(snoozed.nextDueText, /^\d{2}:\d{2}$/)
    assertMatchesSchema(byName.water_snooze.output.schema, snoozed)

    const persisted = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(persisted.stats.snoozes, 1)
  })

  test('control changes the band, the goal, and the on/off state', async (t) => {
    const { byName } = await setup(t)

    const band = await byName.water_control.execute({ action: 'set-band', interval_min_minutes: 90, interval_max_minutes: 60 }, {})
    assert.equal(band.intervalMinMinutes, 60)
    assert.equal(band.intervalMaxMinutes, 90)

    const goal = await byName.water_control.execute({ action: 'set-goal', daily_goal_ml: 1500 }, {})
    assert.equal(goal.goalMl, 1500)

    const stopped = await byName.water_control.execute({ action: 'stop' }, {})
    assert.equal(stopped.enabled, false)
    assert.equal(stopped.nextDueText, '')
    assertMatchesSchema(byName.water_control.output.schema, stopped)

    const started = await byName.water_control.execute({ action: 'start' }, {})
    assert.equal(started.enabled, true)
    assert.match(started.nextDueText, /^\d{2}:\d{2}$/)

    // `reset` drops the runtime overrides and falls back to the configuration.
    const reset = await byName.water_control.execute({ action: 'reset' }, {})
    assert.equal(reset.intervalMinMinutes, 40)
    assert.equal(reset.intervalMaxMinutes, 60)
    assert.equal(reset.goalMl, 2000)
  })

  test('control rejects an action outside its enum before executing', async (t) => {
    const { byName } = await setup(t)
    await assert.rejects(() => byName.water_control.execute({ action: 'explode' }, {}))
  })

  test('remind-now delivers immediately and rearms the timer', async (t) => {
    const { stateFile, byName } = await setup(t)
    const control = await byName.water_control.execute({ action: 'remind-now' }, {})
    assert.match(control.message, /Reminder sent/)
    const persisted = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(persisted.stats.reminders, 1)
    assert.equal(persisted.reminderSeq, 1)
    assert.notEqual(persisted.nextDueAt, null)
  })

  test('restores a previous state file', async (t) => {
    // Seed the file directly instead of driving a first plugin instance: two
    // instances sharing one path would race, and the read path is what this test
    // is about.
    const directory = await mkdtemp(join(tmpdir(), 'water-reminder-restore-'))
    const stateFile = join(directory, 'state.json')
    t.after(() => rm(directory, { recursive: true, force: true }))
    await writeFile(stateFile, `${JSON.stringify({
      version: 1,
      drinks: [{ at: new Date().toISOString(), ml: 250 }],
      enabled: null,
      band: null,
      goalMl: null,
      nextDueAt: null,
      lastReminderAt: null,
      reminderSeq: 3,
      stats: { reminders: 1, drinks: 1, snoozes: 0 },
    })}\n`, 'utf8')

    const { ctx, captured } = harness()
    apply(ctx, { stateFile, dailyGoalMl: 1000 })
    const tools = Object.fromEntries(captured.tools.map(tool => [tool.name, tool]))
    const status = await tools.water_status.execute({}, {})
    assert.equal(status.todayMl, 250)
    assert.equal(status.cups, 1)
    assert.equal(status.percent, 25)
    for (const dispose of captured.disposers) await dispose()
  })

  test('a corrupt state file starts fresh instead of failing the plugin', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'water-reminder-corrupt-'))
    const stateFile = join(directory, 'state.json')
    await writeFile(stateFile, '{ not json', 'utf8')

    const { ctx, captured } = harness()
    apply(ctx, { stateFile })
    const tools = Object.fromEntries(captured.tools.map(tool => [tool.name, tool]))
    const status = await tools.water_status.execute({}, {})
    assert.equal(status.todayMl, 0)
    assert.equal(status.cups, 0)
    // The unreadable file is replaced by a valid one on the next write.
    const log = await tools.water_log.execute({}, {})
    assert.equal(log.todayMl, 250)
    for (const dispose of captured.disposers) await dispose()
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).drinks.length, 1)
    await rm(directory, { recursive: true, force: true })
  })

  test('disposal drains a state write that is already queued', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'water-reminder-drain-'))
    const stateFile = join(directory, 'state.json')
    const { ctx, captured } = harness()
    apply(ctx, { stateFile })
    const log = Object.fromEntries(captured.tools.map(tool => [tool.name, tool])).water_log

    // Settle the initial state load, then start a mutation and let it reach the
    // write queue without awaiting it: disposal must still land it on disk.
    const status = Object.fromEntries(captured.tools.map(tool => [tool.name, tool])).water_status
    await status.execute({}, {})
    void log.execute({ milliliters: 300 }, {})
    await new Promise(resolve => setImmediate(resolve))

    for (const dispose of captured.disposers) await dispose()
    const persisted = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(persisted.drinks.length, 1)
    assert.equal(persisted.drinks[0].ml, 300)
    await rm(directory, { recursive: true, force: true })
  })

  test('a plugin disposed during start-up never writes to disk', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'water-reminder-early-'))
    const stateFile = join(directory, 'state.json')
    const { ctx, captured } = harness()
    apply(ctx, { stateFile })
    // Unload immediately: the state load is still in flight here, and a plugin
    // that armed a timer or wrote state afterwards would be touching the disk
    // after its owner had already torn it down.
    for (const dispose of captured.disposers) await dispose()

    assert.equal(await readFile(stateFile, 'utf8').catch(() => undefined), undefined)
    assert.equal((await readdir(directory)).length, 0)
    await rm(directory, { recursive: true, force: true })
  })

  test('the panel API answers status, drink, snooze, control, and remind-now', async (t) => {
    const { captured, byName } = await setup(t, { dailyGoalMl: 500, cupMl: 200 })
    const handler = captured.routes[0].handler
    const call = async (method, body, expected = 200) => {
      const res = response()
      await handler(request('POST', `/water/api/${method}`, body), res)
      assert.equal(res.captured.status, expected)
      return JSON.parse(res.captured.body)
    }

    const initial = await call('status')
    assert.equal(initial.ok, true)
    assert.equal(initial.value.todayMl, 0)
    assert.equal(initial.value.week.length, 7)

    const drunk = await call('drink', {})
    assert.equal(drunk.ok, true)
    assert.equal(drunk.value.ml, 200)
    assert.equal(drunk.value.status.todayMl, 200)

    const snoozed = await call('snooze', { minutes: 15 })
    assert.equal(snoozed.value.minutes, 15)

    const paused = await call('control', { enabled: false })
    assert.equal(paused.value.enabled, false)

    const fired = await call('remind-now', {})
    assert.equal(fired.ok, true)
    assert.match(fired.value.sentence, /喝水/)
    assert.equal(fired.value.status.reminderSeq, 1)

    const unknown = await call('nope', {}, 404)
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'not-found')

    // The plugin's own status tool agrees with the route it just exercised.
    assert.equal((await byName.water_status.execute({}, {})).todayMl, 200)
  })

  test('the panel API refuses cross-site requests', async (t) => {
    const { captured } = await setup(t)
    const handler = captured.routes[0].handler

    // A page on another origin must not be able to drive the loop: a simple
    // cross-origin POST with a JSON-looking body would otherwise parse fine.
    const crossSite = response()
    await handler(request('POST', '/water/api/control', { enabled: false }, {
      origin: 'https://evil.example',
      host: '127.0.0.1:52730',
    }), crossSite)
    assert.equal(crossSite.captured.status, 403)
    assert.equal(JSON.parse(crossSite.captured.body).error.code, 'cross-site')

    // The literal "null" a sandboxed document sends is refused too.
    const sandboxed = response()
    await handler(request('POST', '/water/api/drink', {}, { origin: 'null', host: '127.0.0.1:52730' }), sandboxed)
    assert.equal(sandboxed.captured.status, 403)

    // Same-origin is the panel's own traffic, and no Origin at all is a CLI client.
    const sameOrigin = response()
    await handler(request('POST', '/water/api/status', {}, { origin: 'http://127.0.0.1:52730', host: '127.0.0.1:52730' }), sameOrigin)
    assert.equal(sameOrigin.captured.status, 200)
    assert.equal(JSON.parse(sameOrigin.captured.body).ok, true)

    const fromCli = response()
    await handler(request('POST', '/water/api/status', {}), fromCli)
    assert.equal(fromCli.captured.status, 200)
  })

  test('the panel API refuses non-POST traffic', async (t) => {
    const { captured } = await setup(t)
    const res = response()
    await captured.routes[0].handler(request('GET', '/water/api/status'), res)
    const payload = JSON.parse(res.captured.body)
    assert.equal(payload.ok, false)
    assert.match(payload.error.message, /POST only/)
  })

  test('the config schema resolves the documented defaults', () => {
    const resolved = Config({})
    // Volatile fields arrive as stable refs; `.get()` yields the snapshot.
    assert.equal(resolved.enabled.get(), true)
    assert.equal(resolved.intervalMinMinutes.get(), 40)
    assert.equal(resolved.intervalMaxMinutes.get(), 60)
    assert.equal(resolved.dailyGoalMl.get(), 2000)
    assert.equal(resolved.cupMl.get(), 250)
    assert.equal(resolved.notify.get().os, true)
    assert.equal(resolved.quietHours.get().enabled, false)
    assert.equal(resolved.promptSection.get(), true)
    assert.equal(resolved.skill.get(), true)
  })
}
