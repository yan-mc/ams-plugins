#!/usr/bin/env node
/**
 * AMS plugins build (M0.6).
 *
 * The two plugin packages are plain ESM / lazy-CJS JavaScript in M0.6, so the
 * build step copies src/ to lib/ (the published entry points), validates the
 * client bundle shape, and optionally packs installable tarballs.
 *
 * Usage:
 *   node tools/build.mjs            # copy src -> lib
 *   node tools/build.mjs --clean    # remove lib/ and dist/
 *   node tools/build.mjs --pack     # copy + pnpm pack each package into dist/
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(REPO, 'dist')

const PACKAGES = [
  { name: '@ams/plugin-core', dir: join(REPO, 'packages', 'plugin-core'), entries: [['src/index.js', 'lib/index.js']] },
  { name: '@ams/plugin-ui', dir: join(REPO, 'packages', 'plugin-ui'), entries: [['src/index.js', 'lib/index.js'], ['src/client.js', 'lib/client.js']] },
  { name: '@ams/music-bundle', dir: join(REPO, 'packages', 'music-bundle'), entries: [] }
]

function copyEntries(pkg) {
  for (const [from, to] of pkg.entries) {
    const source = join(pkg.dir, from)
    const target = join(pkg.dir, to)
    if (!existsSync(source)) throw new Error(pkg.name + ': missing ' + from)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target)
    console.log('[build] ' + pkg.name + ': ' + from + ' -> ' + to + ' (' + String(statSync(target).size) + ' bytes)')
  }
}

function validateClientBundle() {
  const file = join(REPO, 'packages', 'plugin-ui', 'lib', 'client.js')
  const text = readFileSync(file, 'utf8')
  if (!text.includes('window.__ModuleLoader__.load(')) throw new Error('plugin-ui/lib/client.js is not a lazy-CJS bundle')
  if (!text.includes('exports.apply')) throw new Error('plugin-ui/lib/client.js does not export apply')
  console.log('[build] client bundle shape OK (' + String(text.length) + ' bytes)')
}

function runPack() {
  mkdirSync(DIST, { recursive: true })
  const npmExecPath = process.env.npm_execpath
  for (const pkg of PACKAGES) {
    if (existsSync(join(pkg.dir, 'lib')) === false && pkg.name !== '@ams/music-bundle') continue
    const args = npmExecPath
      ? [npmExecPath, 'pack', '--pack-destination', DIST]
      : ['pack', '--pack-destination', DIST]
    const command = npmExecPath ? process.execPath : 'pnpm'
    const result = spawnSync(command, args, { cwd: pkg.dir, stdio: 'inherit', shell: false })
    if (result.status !== 0) throw new Error('pnpm pack failed for ' + pkg.name + ' (exit ' + String(result.status) + ')')
  }
  const tarballs = readdirSync(DIST).filter(name => name.endsWith('.tgz')).sort()
  console.log('[pack] tarballs in dist/: ' + tarballs.join(', '))
  return tarballs
}

const args = new Set(process.argv.slice(2))
if (args.has('--clean')) {
  for (const pkg of PACKAGES) rmSync(join(pkg.dir, 'lib'), { recursive: true, force: true })
  rmSync(DIST, { recursive: true, force: true })
  console.log('[clean] removed lib/ and dist/')
  process.exit(0)
}

for (const pkg of PACKAGES) copyEntries(pkg)
validateClientBundle()
if (args.has('--pack')) runPack()
console.log('[build] done. Install with: dsh plugin --profile music add <dist/*.tgz>')
