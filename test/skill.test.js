/**
 * Tests for the embedded skill and its on-disk twin.
 *
 * The plugin delivers the same instructions two ways — a runtime registration
 * through `ctx.skills` and a `SKILL.md` file for deployments with a filesystem
 * skill root. These tests are what keep those two paths from drifting.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE, skillBody, skillMarkdown } from '../skill.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('the skill name satisfies the registry grammar', () => {
  assert.match(SKILL_NAME, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})

test('the routing description stays short enough for the catalog', () => {
  // dsh-tool-skill caps each rendered description at 500 characters by default.
  assert.ok(SKILL_DESCRIPTION.length > 0 && SKILL_DESCRIPTION.length <= 500, `${SKILL_DESCRIPTION.length} chars`)
  assert.ok(SKILL_WHEN_TO_USE.length > 0 && SKILL_WHEN_TO_USE.length <= 500)
})

test('the generated markdown carries valid frontmatter', () => {
  const markdown = skillMarkdown()
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(markdown)
  assert.notEqual(match, null, 'frontmatter block not found')
  const [, frontmatter, body] = match
  assert.match(frontmatter, new RegExp(`^name: ${SKILL_NAME}$`, 'm'))
  assert.match(frontmatter, /^description: .+$/m)
  assert.match(frontmatter, /^whenToUse: .+$/m)
  assert.equal(body, skillBody())
})

test('the checked-in SKILL.md matches the embedded body byte for byte', async () => {
  const onDisk = await readFile(join(root, 'skills', SKILL_NAME, 'SKILL.md'), 'utf8')
  assert.equal(onDisk, skillMarkdown(), 'run `npm run skill` to regenerate skills/' + SKILL_NAME + '/SKILL.md')
})

test('the body names every tool the plugin registers', () => {
  const body = skillBody()
  for (const tool of ['water_status', 'water_log', 'water_snooze', 'water_control']) {
    assert.ok(body.includes(tool), `skill body does not mention ${tool}`)
  }
})
