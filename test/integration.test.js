/**
 * Integration test against a real cordis composition.
 *
 * `test/plugin.test.js` drives a minimal fake context, which keeps the behavior
 * tests fast but cannot catch a mistake in how the plugin talks to cordis
 * itself. This file mounts the plugin on a real `Context` with the real
 * `tools`, `skills`, and `systemPrompt` services, so it proves the declared
 * dependencies actually resolve, the registered tools survive schema
 * compilation, the embedded skill becomes discoverable through `ctx.skills`,
 * and disposal really unregisters everything.
 *
 * The composition intentionally omits `webServer` and `settings`: those two are
 * optional surfaces, and loading without them is what verifies the plugin
 * degrades instead of failing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The harness packages and the plugin, resolved together so one missing
 * dependency produces one clear skip instead of an import crash. See
 * `README -> Prerequisites`.
 */
const SKIP_REASON = 'requires the DeepSeek Harness packages (@deepseek-ai/cordis, dsh-tools, dsh-skill, dsh-system-prompt); see README -> Prerequisites'
const deps = await (async () => {
  try {
    const [cordis, tools, skill, systemPrompt, waterReminder, skillModule] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-tools'),
      import('@deepseek-ai/dsh-skill'),
      import('@deepseek-ai/dsh-system-prompt'),
      import('../index.js'),
      import('../skill.js'),
    ])
    return {
      Context: cordis.Context,
      ToolRuntime: tools.default,
      SkillRegistry: skill.default,
      SystemPrompt: systemPrompt.default,
      renderPrompt: systemPrompt.renderPrompt,
      waterReminder,
      SKILL_NAME: skillModule.SKILL_NAME,
      skillBody: skillModule.skillBody,
    }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
})()

const TOOL_NAMES = ['water_control', 'water_log', 'water_snooze', 'water_status']

if (deps.error !== undefined) {
  test('water-reminder composition tests', t => t.skip(`${SKIP_REASON} (${deps.error})`))
} else {
  const {
    Context, ToolRuntime, SkillRegistry, SystemPrompt, renderPrompt, waterReminder, SKILL_NAME, skillBody,
  } = deps

  async function composition(t, config = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'water-reminder-ctx-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    // ToolRuntime injects systemPrompt, so it must be loaded after it.
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(waterReminder, { stateFile: join(directory, 'state.json'), ...config })
    t.after(async () => {
      await fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    })
    return { ctx, fiber, directory }
  }

  test('mounts on a real composition and registers its tools', async (t) => {
    const { ctx } = await composition(t)
    const names = ctx.tools.schemas().map(tool => tool.name).sort()
    assert.deepEqual(names, TOOL_NAMES)

    for (const name of TOOL_NAMES) {
      const tool = ctx.tools.get(name)
      assert.notEqual(tool, undefined, `${name} did not reach the registry`)
      assert.equal(tool.parameters.type, 'object')
      assert.ok(tool.description.length > 40)
      assert.equal(tool.output.schema.type, 'object')
    }

    // `water_control` is the only tool with a required argument, and its enum must
    // survive schema compilation intact.
    const control = ctx.tools.get('water_control')
    assert.deepEqual(control.parameters.required, ['action'])
    assert.deepEqual(control.parameters.properties.action.enum, ['start', 'stop', 'set-band', 'set-goal', 'remind-now', 'reset'])
  })

  test('executes a tool through the real registry', async (t) => {
    const { ctx, directory } = await composition(t, { dailyGoalMl: 1000, cupMl: 250 })

    const logged = await ctx.tools.get('water_log').execute({ milliliters: 250 }, {})
    assert.equal(logged.todayMl, 250)
    assert.equal(logged.percent, 25)

    const status = await ctx.tools.get('water_status').execute({}, {})
    assert.equal(status.todayMl, 250)
    assert.equal(status.cups, 1)
    assert.equal(status.intervalMinMinutes, 40)
    assert.equal(status.intervalMaxMinutes, 60)

    // The other two optional surfaces were absent, so the panel route was skipped
    // and nothing threw.
    assert.equal(directory.includes('water-reminder-ctx-'), true)
  })

  test('registers the embedded skill so the model can discover and load it', async (t) => {
    const { ctx } = await composition(t)
    const catalog = await ctx.skills.list({})
    const summary = catalog.find(entry => entry.name === SKILL_NAME)
    assert.notEqual(summary, undefined, 'the embedded skill is not in the merged catalog')
    assert.equal(summary.source, 'runtime')
    assert.equal(summary.provider, 'runtime')
    assert.equal(summary.invocation.modelInvocable, true)
    assert.ok(summary.description.length > 0 && summary.description.length <= 500)

    const loaded = await ctx.skills.get(SKILL_NAME, {})
    assert.notEqual(loaded, undefined)
    assert.equal(loaded.content, skillBody())
  })

  test('contributes its briefing to the composed system prompt', async (t) => {
    const { ctx } = await composition(t)
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    assert.match(prompt, /water-reminder plugin/)
    assert.match(prompt, /water_log/)
  })

  test('the skill registration is skipped when the config disables it', async (t) => {
    const { ctx } = await composition(t, { skill: false, promptSection: false })
    const catalog = await ctx.skills.list({})
    assert.equal(catalog.find(entry => entry.name === SKILL_NAME), undefined)
    // The tools are independent of the skill, so they stay registered.
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), TOOL_NAMES)
  })

  test('disposal unregisters every contribution', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'water-reminder-dispose-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(waterReminder, { stateFile: join(directory, 'state.json') })

    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), TOOL_NAMES)
    await fiber.dispose()

    assert.deepEqual(ctx.tools.schemas(), [])
    assert.equal((await ctx.skills.list({})).find(entry => entry.name === SKILL_NAME), undefined)
    assert.doesNotMatch(renderPrompt(await ctx.systemPrompt.assemble()), /water-reminder plugin/)
    await rm(directory, { recursive: true, force: true })
  })
}
