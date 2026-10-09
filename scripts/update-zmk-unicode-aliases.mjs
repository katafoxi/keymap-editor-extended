import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Pin the definitions, not README examples (the example's OE/UE comments differ).
const revision = '6ce21267e497e20ff9e05da16d4eefcdd3e89190'
const base = `https://raw.githubusercontent.com/urob/zmk-unicode/${revision}/`
const dataDir = new URL('../packages/keymap-core/data/', import.meta.url)
const check = process.argv.includes('--check')

async function fetchText(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response.text()
}

const index = await fetchText('include/zmk-unicode/keys.h')
const paths = [...index.matchAll(/^#include <([^>]+)>/gm)].map(match => match[1])
if (paths.length !== 17 || paths.some(path => !/^zmk-unicode\/keys\/\w+\.h$/.test(path))) {
  throw new Error('Unexpected upstream curated header inventory')
}
const headers = await Promise.all(paths.map(path => fetchText(`include/${path}`)))
const aliases = headers.flatMap((text, index) => {
  const group = paths[index].split('/').at(-1).replace(/\.h$/, '')
    .split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' ')
  return text.split('\n').filter(line => line.startsWith('#define ')).map(line => {
    const match = /^#define\s+(UC_\w+)\s+(0x[\da-fA-F]+)\s+(0x[\da-fA-F]+|0)\b/.exec(line)
    if (!match) throw new Error(`Unsupported alias definition: ${line}`)
    return { code: match[1], normal: parseInt(match[2], 16), shift: parseInt(match[3], 16), group }
  })
})
if (aliases.length !== 292 || new Set(aliases.map(row => row.code)).size !== aliases.length) {
  throw new Error('Unexpected alias count or duplicate definitions')
}
const scalar = value => Number.isInteger(value) && value >= 0 && value <= 0x10ffff &&
  !(value >= 0xd800 && value <= 0xdfff)
if (aliases.some(row => !scalar(row.normal) || !scalar(row.shift))) {
  throw new Error('Invalid upstream Unicode scalar')
}
const outputs = [
  ['zmk-unicode-aliases.json', JSON.stringify({ source: `https://github.com/urob/zmk-unicode/tree/${revision}`, aliases }, null, 2) + '\n'],
  ['zmk-unicode-LICENSE.txt', await fetchText('LICENSE')]
]
for (const [name, content] of outputs) {
  const target = new URL(name, dataDir)
  if (check) {
    if (await readFile(target, 'utf8') !== content) throw new Error(`Vendored file differs: ${name}`)
  } else await writeFile(target, content)
}
console.log(`${check ? 'Verified' : 'Updated'} ${aliases.length} aliases from ${paths.length} pinned upstream headers in ${fileURLToPath(dataDir)}`)
