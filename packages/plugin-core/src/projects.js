import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

function root(home) { return join(home, 'projects') }
function safe(name) {
  const value = String(name || '').trim()
  if (!value || value.length > 64 || /[\\/:*?"<>|]/.test(value) || value === 'imports') throw new Error('非法工程名')
  return value
}
export function listProjects(home) {
  const base = root(home); const out = []
  let entries = []; try { entries = readdirSync(base) } catch { return out }
  for (const id of entries) {
    if (id === 'imports' || id.startsWith('_')) continue
    const dir = join(base, id); try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    let meta = null; try { meta = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) } catch { continue }
    out.push({ id, name: meta.name || id, created_at: meta.created_at || '', updated_at: meta.updated_at || '', path: dir })
  }
  return out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
}
export function createProject(home, name) {
  const clean = safe(name); const base = root(home); mkdirSync(base, { recursive: true })
  const id = 'p_' + Date.now().toString(36); const dir = join(base, id)
  for (const sub of ['assets', 'mix', 'reports', 'exports']) mkdirSync(join(dir, sub), { recursive: true })
  const now = new Date().toISOString()
  const meta = { schema: 'ams.project/1', id, name: clean, created_at: now, updated_at: now, assets: [], steps: [], outputs: [] }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
  return { id, name: clean, path: dir }
}
export function projectDir(home, id) {
  const clean = String(id || '')
  if (!clean || clean.includes('/') || clean.includes('\\') || clean === 'imports') throw new Error('非法工程 id')
  const dir = join(root(home), clean); if (!existsSync(dir)) throw new Error('工程不存在')
  return dir
}
export function readProject(home, id) { return JSON.parse(readFileSync(join(projectDir(home, id), 'project.json'), 'utf8')) }
export function trashProject(home, id, moveToTrash) { moveToTrash(projectDir(home, id), 'projects') }
export function exportProject(home, id, tarExe) {
  const dir = projectDir(home, id); const out = join(home, 'exports', 'projects'); mkdirSync(out, { recursive: true })
  const target = join(out, id + '-' + Date.now() + '.zip')
  const result = spawnSync(tarExe(), ['-a', '-c', '-f', target, '-C', dir, '.'], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('打包失败：' + String(result.stderr || '').slice(0, 300))
  return target
}
