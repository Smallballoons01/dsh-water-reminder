/**
 * `client.js` 的主题 token 约束测试。
 *
 * 起因是一次真实故障：`--dsw-alias-text-primary` / `--dsw-alias-text-tertiary` 这两个
 * 名字看着完全合理，实际**不存在** —— 这套设计系统的文字 token 是 `label-*` 系列。
 * 名字写错不会报错，只会静默落到 fallback；在深色主题下 `var(--…, inherit)` 之类的
 * 兜底会把正文刷成读不出来的颜色。
 *
 * 另一类故障是把**中性强调色**当背景用：`brand-text` / `brand-primary` 在浅色主题取
 * 近黑、深色主题取近白，铺成按钮底就成了浅底白字。填充色必须写死。
 *
 * 这两条都钉在这里了。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(root, 'client.js'), 'utf8')
const lines = source.split('\n')

/** 逐行扫，跳过注释（注释里会引用反面示例，不该被当成违规）。 */
function usedTokens() {
  const used = new Set()
  for (const line of lines) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    for (const match of line.matchAll(/--dsw-alias-([a-z0-9-]+)/g)) used.add(match[1])
  }
  return used
}

/**
 * 已确认**有真实定义**的 token。取自运行中实例的客户端 bundle：
 *   grep -o -- '--dsw-alias-<名>: *[^;}]*' bundle.js     # 带冒号才是「有定义」
 * 只被 `var(...)` 引用而没有定义的，是遗留名，会静默 fallback。
 */
const KNOWN_TOKENS = new Set([
  'label-primary', 'label-secondary', 'label-tertiary', 'label-caption',
  'bg-base', 'bg-layer-1', 'bg-layer-2',
  'border-l1', 'border-l2', 'border-l3', 'border-l4',
  'interactive-bg-hover', 'interactive-bg-hover-danger', 'interactive-bg-active',
  'state-success-primary', 'state-error-primary', 'state-warn-primary', 'state-warn-label',
  'state-business-primary',
  'brand-primary', 'brand-text',
  'scrollbar-bg-l2', 'scrollbar-hover-l2',
])

test('只用真实存在的主题 token', () => {
  const used = usedTokens()
  const unknown = [...used].filter(name => !KNOWN_TOKENS.has(name))
  assert.deepEqual(
    unknown, [],
    `用到了未经验证的 token：${unknown.join('、')}。`
    + '改成 KNOWN_TOKENS 里的名字，或先按文件头注释里的方法到真实 bundle 里核实它有定义。',
  )
  for (const required of ['label-primary', 'label-tertiary', 'bg-layer-1']) {
    assert.ok(used.has(required), `应当在用 --dsw-alias-${required}`)
  }
})

test('填充色写死，不用中性强调色当背景', () => {
  // brand-text / brand-primary 名义上像品牌色，实际是中性强调色（浅色主题近黑、
  // 深色主题近白）。拿它铺按钮底 = 浅底白字。
  const asBackground = lines
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text))
    .filter(({ text }) => /background:\s*var\(--dsw-alias-(brand-text|brand-primary)/.test(text))
  assert.deepEqual(
    asBackground.map(hit => hit.line), [],
    `第 ${asBackground[0]?.line} 行把中性强调色当背景了；填充色请写死（如 #3d5fd9）。`,
  )

  // 主按钮确实用了写死的实色，且配了白字。
  assert.match(source, /\.dsh-wr-primary\s*\{[^}]*background:\s*#[0-9a-f]{6}/,
    '主按钮应当使用写死的填充色')
  assert.match(source, /\.dsh-wr-primary\s*\{[^}]*color:\s*#fff/, '主按钮应当配白字')
})

test('兜底值用系统色或中性色，不用 inherit', () => {
  const inheritFallbacks = lines
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text))
    .filter(({ text }) => /var\(--dsw-alias-[a-z0-9-]+,\s*inherit\)/.test(text))
  assert.deepEqual(
    inheritFallbacks.map(hit => hit.line), [],
    `第 ${inheritFallbacks[0]?.line} 行把兜底写成了 inherit —— 与背景色不配对，深色主题下会读不出来。`,
  )
  for (const [token, system] of [
    ['label-primary', 'CanvasText'],
    ['label-tertiary', 'GrayText'],
    ['bg-layer-1', 'Canvas'],
  ]) {
    assert.match(source, new RegExp(`var\\(--dsw-alias-${token}, ${system}\\)`),
      `--dsw-alias-${token} 的兜底应当是系统色 ${system}`)
  }
})
