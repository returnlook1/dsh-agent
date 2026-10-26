#!/usr/bin/env node
/**
 * Generate `dist/catalog.json` from the compiled tool set.
 *
 * Why this imports `dist/catalog.js` instead of parsing `src/tools/*.ts`:
 * `buildCatalog()` reads the *same* `BUSINESS_TOOLS` array that `apply()` registers,
 * including each tool's compiled parameter JSON Schema. Parsing TypeScript with a
 * hand-written regex would be a second source of truth and could drift silently —
 * exactly what docs/IMPL-PLUGINS.md §2 asks us to avoid. `tsc` therefore runs first
 * (`npm run build` = `tsc && node scripts/build-catalog.mjs`).
 *
 * Usage:
 *   node scripts/build-catalog.mjs           # write dist/catalog.json
 *   node scripts/build-catalog.mjs --check   # exit 1 when the file is stale/missing
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(scriptDirectory, '..')
const distDirectory = join(packageRoot, 'dist')
const target = join(distDirectory, 'catalog.json')
const modulePath = join(distDirectory, 'catalog.js')
const checkOnly = process.argv.includes('--check')

let buildCatalog
try {
  ;({ buildCatalog } = await import(pathToFileURL(modulePath).href))
} catch (error) {
  console.error(`[build-catalog] 无法加载 ${modulePath}：${/** @type {Error} */ (error).message}`)
  console.error('[build-catalog] 请先运行 tsc（npm run build 会先编译再生成目录）')
  process.exit(1)
}

const catalog = buildCatalog()
const serialized = `${JSON.stringify(catalog, null, 2)}\n`

if (checkOnly) {
  let existing
  try {
    existing = readFileSync(target, 'utf8')
  } catch {
    console.error(`[build-catalog] ${target} 不存在`)
    process.exit(1)
  }
  if (existing !== serialized) {
    console.error(`[build-catalog] ${target} 与工具定义不一致，请重新运行构建`)
    process.exit(1)
  }
  console.log(`[build-catalog] OK: ${catalog.entries.length} entries up to date`)
  process.exit(0)
}

mkdirSync(distDirectory, { recursive: true })
const temporary = join(distDirectory, `.catalog.${process.pid}.tmp`)
writeFileSync(temporary, serialized, 'utf8')
try {
  // Windows: rename cannot replace an existing file.
  rmSync(target, { force: true })
  renameSync(temporary, target)
} catch (error) {
  rmSync(temporary, { force: true })
  console.error(`[build-catalog] 写入失败：${/** @type {Error} */ (error).message}`)
  process.exit(1)
}

console.log(`[build-catalog] wrote ${target} (${catalog.entries.length} entries)`)
