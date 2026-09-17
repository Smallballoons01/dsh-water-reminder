/**
 * Regenerate `skills/hydration-coach/SKILL.md` from the embedded skill source.
 *
 * The plugin's runtime skill registration and the on-disk skill file are two
 * delivery paths for the same instructions. This script keeps the file derived
 * from `skill.js`; `pnpm test` asserts the two never diverge.
 *
 * Usage: node scripts/generate-skill.mjs [--check]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skillMarkdown, SKILL_NAME } from '../skill.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, 'skills', SKILL_NAME, 'SKILL.md')
const markdown = skillMarkdown()
const check = process.argv.includes('--check')

if (check) {
  const existing = await readFile(target, 'utf8').catch(() => undefined)
  if (existing !== markdown) {
    console.error(`out of date: ${target} — run \`node scripts/generate-skill.mjs\``)
    process.exit(1)
  }
  console.log(`up to date: ${target}`)
} else {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, markdown, 'utf8')
  console.log(`wrote ${target} (${markdown.length} bytes)`)
}
