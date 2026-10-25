import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, cpSync } from 'node:fs'
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

export function appendProjectStep(home, id, job) {
  if (!id) return
  const dir = projectDir(home, id); const file = join(dir, 'project.json')
  const meta = JSON.parse(readFileSync(file, 'utf8'))
  const steps = Array.isArray(meta.steps) ? meta.steps : []
  const step = { job_id: job.id, type: job.type, status: job.status || 'queued', params: job.params || {}, created_at: job.created_at || new Date().toISOString() }
  const existing = steps.findIndex(item => item.job_id === job.id)
  if (existing >= 0) steps[existing] = Object.assign({}, steps[existing], step)
  else steps.push(step)
  meta.steps = steps; meta.updated_at = new Date().toISOString()
  writeFileSync(file, JSON.stringify(meta, null, 2), 'utf8')
}
export function importProject(home, archive, name, tarExe) {
  const source = String(archive || '')
  if (!source.toLowerCase().endsWith('.zip') || !existsSync(source)) throw new Error('工程 zip 不存在')
  const tmp = join(home, 'tmp', 'project-import-' + Date.now()); mkdirSync(tmp, { recursive: true })
  const result = spawnSync(tarExe(), ['-xf', source, '-C', tmp], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('解包失败：' + String(result.stderr || '').slice(0, 300))
  let found = null
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (entry === 'project.json' && statSync(full).isFile()) { found = full; return }
      if (statSync(full).isDirectory()) { walk(full); if (found) return }
    }
  }
  walk(tmp)
  if (!found) throw new Error('工程包中没有 project.json')
  const meta = JSON.parse(readFileSync(found, 'utf8'))
  const id = 'p_' + Date.now().toString(36)
  const target = join(root(home), id)
  mkdirSync(root(home), { recursive: true })
  cpSync(join(found, '..'), target, { recursive: true })
  meta.id = id; meta.name = name && String(name).trim() ? String(name).trim() : (meta.name || id); meta.updated_at = new Date().toISOString()
  writeFileSync(join(target, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
  return { id, name: meta.name, path: target }
}

export function exportProject(home, id, tarExe) {
  const dir = projectDir(home, id); const out = join(home, 'exports', 'projects'); mkdirSync(out, { recursive: true })
  const target = join(out, id + '-' + Date.now() + '.zip')
  const result = spawnSync(tarExe(), ['-a', '-c', '-f', target, '-C', dir, '.'], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('打包失败：' + String(result.stderr || '').slice(0, 300))
  return target
}
