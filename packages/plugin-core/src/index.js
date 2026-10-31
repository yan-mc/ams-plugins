/**
 * AMS plugin-core (Host): model-facing tools + authenticated local bridge routes.
 *
 * M1 (task-22) hardening:
 * - Every /ams/api/* request needs a credential: either
 *   (a) Authorization: Bearer <gateway token> for machine callers, or
 *   (b) a short-lived HttpOnly same-origin session cookie issued by
 *       GET /ams/api/session for the browser page.
 * - GET /ams/api/jobs/{id}/events pipes the Gateway SSE stream through, so the
 *   browser page can use EventSource instead of polling.
 *
 * The Gateway token never leaves this Host process.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream, readdirSync, statSync, renameSync, cpSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
function projectsRoot(home) { return join(home, 'projects') }
function projectName(name) { const value = String(name || '').trim(); if (!value || value.length > 64 || /[\\/:*?"<>|]/.test(value) || value === 'imports') throw new Error('非法工程名'); return value }
function listProjects(home) { const base=projectsRoot(home); const out=[]; let entries=[]; try{entries=readdirSync(base)}catch{return out}; for(const id of entries){ if(id==='imports'||id.startsWith('_'))continue; const dir=join(base,id); try{if(!statSync(dir).isDirectory())continue}catch{continue}; let meta=null; try{meta=JSON.parse(readFileSync(join(dir,'project.json'),'utf8'))}catch{continue}; out.push({id,name:meta.name||id,created_at:meta.created_at||'',updated_at:meta.updated_at||'',path:dir}) } return out }
function createProject(home,name) { const clean=projectName(name); const base=projectsRoot(home); mkdirSync(base,{recursive:true}); const id='p_'+Date.now().toString(36); const dir=join(base,id); for(const sub of ['assets','mix','reports','exports'])mkdirSync(join(dir,sub),{recursive:true}); const now=new Date().toISOString(); const meta={schema:'ams.project/1',id,name:clean,created_at:now,updated_at:now,assets:[],steps:[],outputs:[]}; writeFileSync(join(dir,'project.json'),JSON.stringify(meta,null,2),'utf8'); return {id,name:clean,path:dir} }
function projectDir(home,id) { const clean=String(id||''); if(!clean||clean.includes('/')||clean.includes('\\')||clean==='imports')throw new Error('非法工程 id'); const dir=join(projectsRoot(home),clean); if(!existsSync(dir))throw new Error('工程不存在'); return dir }
function readProject(home,id) { return JSON.parse(readFileSync(join(projectDir(home,id),'project.json'),'utf8')) }
function trashProject(home,id,moveToTrash) { moveToTrash(projectDir(home,id),'projects') }
function exportProject(home,id,tarExe) { const dir=projectDir(home,id); const out=join(home,'exports','projects'); mkdirSync(out,{recursive:true}); const target=join(out,id+'-'+Date.now()+'.zip'); const r=spawnSync(tarExe(),['-a','-c','-f',target,'-C',dir,'.'],{windowsHide:true,encoding:'utf8'}); if(r.status!==0)throw new Error('打包失败：'+String(r.stderr||'').slice(0,300)); return target }
function appendProjectStep(home,id,job) { if(!id)return; const dir=projectDir(home,id); const file=join(dir,'project.json'); const meta=JSON.parse(readFileSync(file,'utf8')); const steps=Array.isArray(meta.steps)?meta.steps:[]; const step={job_id:job.id,type:job.type,status:job.status||'queued',params:job.params||{},created_at:job.created_at||new Date().toISOString()}; const i=steps.findIndex(x=>x.job_id===job.id); if(i>=0)steps[i]=Object.assign({},steps[i],step); else steps.push(step); meta.steps=steps; meta.updated_at=new Date().toISOString(); writeFileSync(file,JSON.stringify(meta,null,2),'utf8') }
function updateProjectStep(home, id, job) {
  if (!id) return
  try {
    const dir = projectDir(home, id); const file = join(dir, 'project.json')
    const meta = JSON.parse(readFileSync(file, 'utf8')); const steps = Array.isArray(meta.steps) ? meta.steps : []
    const item = { job_id: job.id, type: job.type, status: job.status || 'queued', progress: job.progress || 0, error: job.error || null, updated_at: new Date().toISOString() }
    const i = steps.findIndex(x => x.job_id === job.id); if (i >= 0) steps[i] = Object.assign({}, steps[i], item); else steps.push(item)
    meta.steps = steps; meta.updated_at = new Date().toISOString(); writeFileSync(file, JSON.stringify(meta, null, 2), 'utf8')
  } catch { /* project deleted */ }
}
const PROJECT_WATCHERS = new Map()
function watchProjectJob(home, projectId, jobId) {
  if (!projectId || !jobId || PROJECT_WATCHERS.has(jobId)) return
  const stop = () => PROJECT_WATCHERS.delete(jobId)
  PROJECT_WATCHERS.set(jobId, stop)
  ;(async () => {
    for (let i = 0; i < 3600; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      try {
        const job = await gatewayJob(jobId)
        updateProjectStep(home, projectId, job)
        if (['succeeded', 'failed', 'cancelled'].includes(job.status)) { stop(); return }
      } catch { /* retry */ }
    }
    stop()
  })()
}
function importProject(home,archive,name,tarExe) { const src=String(archive||''); if(!src.toLowerCase().endsWith('.zip')||!existsSync(src))throw new Error('工程 zip 不存在'); const tmp=join(home,'tmp','project-import-'+Date.now()); mkdirSync(tmp,{recursive:true}); const r=spawnSync(tarExe(),['-xf',src,'-C',tmp],{windowsHide:true,encoding:'utf8'}); if(r.status!==0)throw new Error('解包失败'); let found=null; const walk=dir=>{for(const e of readdirSync(dir)){const full=join(dir,e); if(e==='project.json'&&statSync(full).isFile()){found=full;return} if(statSync(full).isDirectory()){walk(full);if(found)return}}}; walk(tmp); if(!found)throw new Error('没有 project.json'); const meta=JSON.parse(readFileSync(found,'utf8')); const id='p_'+Date.now().toString(36); const target=join(projectsRoot(home),id); cpSync(join(found,'..'),target,{recursive:true}); meta.id=id; meta.name=name?projectName(name):(meta.name||id); meta.updated_at=new Date().toISOString(); writeFileSync(join(target,'project.json'),JSON.stringify(meta,null,2),'utf8'); return {id,name:meta.name,path:target} }


export const name = 'ams-plugin-core'
export const inject = ['tools', 'webServer']

const PLUGIN_VERSION = '0.3.0'
const ROUTE_PREFIX = '/ams/api'
const TOOL_NAMES = ['music_ping', 'music_job_submit', 'music_job_status', 'music_job_list', 'music_job_cancel']
const SESSION_COOKIE = 'ams_bridge'
const SESSION_TTL_MS = 30 * 60 * 1000
const SESSION_MAX = 128
const SSE_HEARTBEAT_MS = 15000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** In-memory browser sessions: token -> { createdAt, expiresAt, lastSeen }. */
const sessions = new Map()

/** Resolve the AMS data root from the kernel's own DSH_HOME or executable path. */
function resolveAmsHome() {
  const dshHome = process.env.DSH_HOME
  if (typeof dshHome === 'string' && dshHome.trim() !== '') {
    const normalized = dshHome.trim()
    return dirname(dirname(normalized))
  }
  return dirname(dirname(process.execPath))
}


const TEMPLATE_KINDS = new Set(['rvc', 'pymss', 'msvc'])
const SAFE_NAME = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,64}$/

function templatesRoot() { return join(resolveAmsHome(), 'config', 'templates') }
function trashRoot() { return join(resolveAmsHome(), 'trash') }

function safeVoiceName(name) {
  const value = String(name || '').trim()
  if (!SAFE_NAME.test(value) || value === '.' || value === '..') throw new Error('非法音色名称')
  return value
}

function templatePath(kind, name) {
  if (!TEMPLATE_KINDS.has(kind)) throw new Error('未知模板类型')
  if (!SAFE_NAME.test(name)) throw new Error('非法模板名称')
  return join(templatesRoot(), kind, name + '.json')
}

function readVoiceMetadata(name) {
  const file = join(resolveAmsHome(), 'voices', name, 'voice.json')
  if (!existsSync(file)) return { name, tags: [], note: '', favorite: false }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return Object.assign({ name }, data, { tags: Array.isArray(data.tags) ? data.tags : [] })
  } catch { return { name, tags: [], note: '', favorite: false } }
}

function listTemplates() {
  const result = []
  for (const kind of TEMPLATE_KINDS) {
    const dir = join(templatesRoot(), kind)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue
      try {
        const data = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
        result.push({ kind, name: entry.slice(0, -5), params: data.params || data, saved_at: data.saved_at || null })
      } catch { /* skip invalid */ }
    }
  }
  return result
}

function saveTemplate(kind, name, params) {
  const file = templatePath(kind, name)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify({ schema: 'ams.param-template/1', kind, name, saved_at: new Date().toISOString(), params }, null, 2))
  renameSync(tmp, file)
  return { kind, name }
}

function moveToTrash(source, area) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(trashRoot(), area, stamp + '-' + basename(source))
  mkdirSync(dirname(dest), { recursive: true })
  renameSync(source, dest)
  return dest
}


async function previewVoice(body) {
  const name = String(body.voice_name || '').trim()
  if (!name) throw new Error('缺少 voice_name')
  const sample = join(resolveAmsHome(), 'assets', 'preview_voice.wav')
  if (!existsSync(sample)) throw new Error('缺少试听样本 data/assets/preview_voice.wav')
  const job = await gatewaySubmit('convert.rvc', {
    input_path: sample,
    voice_name: name,
    f0_up_key: 0,
    f0_method: 'rmvpe',
    index_rate: 0.5,
    index_path: '',
    filter_radius: 3,
    resample_sr: 0,
    rms_mix_rate: 0.25,
    protect: 0.33,
    device: 'cuda:0'
  })
  const jobId = String(job && job.id ? job.id : '')
  if (!jobId) throw new Error('Gateway 未返回试听任务 id')
  for (let i = 0; i < 90; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const status = await gatewayJob(jobId)
    if (status.status === 'failed' || status.status === 'cancelled') throw new Error('试听任务失败：' + String(status.error && status.error.message ? status.error.message : status.status))
    if (status.status === 'succeeded') {
      const list = await gatewayArtifacts(jobId)
      const artifacts = Array.isArray(list.data) ? list.data : (Array.isArray(list) ? list : [])
      return { job_id: jobId, artifacts }
    }
  }
  throw new Error('试听任务超时')
}


function tarExe() { return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') }

function findPth(dir, depth = 0) {
  if (depth > 4) return null
  let entries = []
  try { entries = readdirSync(dir) } catch { return null }
  for (const entry of entries) {
    const full = join(dir, entry)
    let info
    try { info = statSync(full) } catch { continue }
    if (info.isFile() && entry.toLowerCase().endsWith('.pth')) return full
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    try { if (statSync(full).isDirectory()) { const found = findPth(full, depth + 1); if (found) return found } } catch { /* skip */ }
  }
  return null
}


function listDatasets() {
  const root = join(resolveAmsHome(), 'datasets')
  const result = []
  let entries = []
  try { entries = readdirSync(root) } catch { return result }
  for (const name of entries) {
    if (name.startsWith('_')) continue
    const dir = join(root, name)
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    let meta = {}
    try { meta = JSON.parse(readFileSync(join(dir, 'dataset.json'), 'utf8')) } catch { /* no meta */ }
    result.push({ name, clip_count: Number(meta.clip_count || 0), total_seconds: Number(meta.total_seconds || 0), created_at: meta.created_at || '', path: dir })
  }
  return result.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

function exportVoicepack(name) {
  const source = join(resolveAmsHome(), 'voices', safeVoiceName(name))
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error('音色不存在')
  if (!existsSync(tarExe())) throw new Error('Windows tar.exe 不可用')
  const dir = join(resolveAmsHome(), 'exports', 'voicepacks')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, safeVoiceName(name) + '-' + Date.now() + '.zip')
  const result = spawnSync(tarExe(), ['-a', '-c', '-f', target, '-C', source, '.'], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('打包失败：' + String(result.stderr || result.error || '').slice(0, 500))
  return target
}

function importVoicepack(archive, requestedName) {
  const file = String(archive || '')
  if (!file.toLowerCase().endsWith('.zip') || !existsSync(file)) throw new Error('voicepack zip 不存在')
  const tmp = join(resolveAmsHome(), 'tmp', 'voice-import-' + randomBytes(6).toString('hex'))
  mkdirSync(tmp, { recursive: true })
  const result = spawnSync(tarExe(), ['-xf', file, '-C', tmp], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('解包失败：' + String(result.stderr || result.error || '').slice(0, 500))
  const pth = findPth(tmp)
  if (!pth) throw new Error('voicepack 中没有 .pth')
  const name = safeVoiceName(requestedName || pth.split(/[\\/]/).pop().replace(/\.pth$/i, ''))
  const sourceDir = pth.includes(tmp + sep) ? dirname(pth) : tmp
  const target = join(resolveAmsHome(), 'voices', name)
  if (existsSync(target)) moveToTrash(target, 'voices')
  mkdirSync(target, { recursive: true })
  cpSync(sourceDir, target, { recursive: true })
  return { name, path: target }
}

const DATA_FOLDERS = {
  rvc_voices: 'voices',
  artifacts: 'artifacts'
}

const VC_PORT = 7801
const VC_BASE = 'http://127.0.0.1:' + VC_PORT

async function vcHealth() {
  try {
    const response = await fetch(VC_BASE + '/vc/health', { signal: AbortSignal.timeout(700) })
    return response.ok
  } catch {
    return false
  }
}

async function ensureVcService() {
  if (await vcHealth()) return
  const home = resolveAmsHome()
  const runtimePath = join(home, 'config', 'runtime.json')
  let runtime = null
  try { runtime = JSON.parse(readFileSync(runtimePath, 'utf8')) } catch { runtime = null }
  const python = runtime && typeof runtime.rvc_python === 'string' ? runtime.rvc_python : ''
  const rvcRoot = runtime && typeof runtime.rvc_root === 'string' ? runtime.rvc_root : ''
  const script = join(home, 'components', 'vc-service', 'ams_vc_service.py')
  if (!python || !rvcRoot || !existsSync(python) || !existsSync(script)) {
    throw new Error('VC 服务未安装或 RVC runtime 路径缺失')
  }
  const temp = join(home, 'tmp')
  const cache = join(home, 'cache')
  const cacheDirs = {
    torch: join(cache, 'torch'),
    extensions: join(cache, 'torch-extensions'),
    hf: join(cache, 'huggingface'),
    xdg: cache,
    mpl: join(cache, 'matplotlib'),
    numba: join(cache, 'numba'),
    pycache: join(cache, 'pycache')
  }
  mkdirSync(temp, { recursive: true })
  for (const dir of Object.values(cacheDirs)) mkdirSync(dir, { recursive: true })
  const child = spawn(python, [script, '--port', String(VC_PORT)], {
    cwd: rvcRoot,
    env: Object.assign({}, process.env, {
      AMS_RVC_ROOT: rvcRoot,
      AMS_HOME: home,
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
      TORCH_HOME: cacheDirs.torch,
      TORCH_EXTENSIONS_DIR: cacheDirs.extensions,
      HF_HOME: cacheDirs.hf,
      HUGGINGFACE_HUB_CACHE: join(cacheDirs.hf, 'hub'),
      TRANSFORMERS_CACHE: join(cacheDirs.hf, 'transformers'),
      XDG_CACHE_HOME: cacheDirs.xdg,
      MPLCONFIGDIR: cacheDirs.mpl,
      NUMBA_CACHE_DIR: cacheDirs.numba,
      PYTHONPYCACHEPREFIX: cacheDirs.pycache
    }),
    detached: false,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  for (let i = 0; i < 40; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 500))
    if (await vcHealth()) return
  }
  throw new Error('VC 服务启动超时；检查 data/components/vc-service 与 RVC runtime')
}

async function vcRequest(pathname, method, body) {
  await ensureVcService()
  const init = { method, headers: {} }
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body || {})
  }
  const response = await fetch(VC_BASE + pathname, init)
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = { ok: false, raw: text } }
  return { status: response.status, payload }
}

function openDataFolder(kind) {
  const folder = DATA_FOLDERS[kind]
  if (!folder) throw new Error('不支持的数据目录类型：' + String(kind))
  const root = resolve(resolveAmsHome())
  const path = resolve(root, folder)
  if (path !== root && !path.startsWith(root + sep)) throw new Error('目标目录不在 AMS data 内')
  mkdirSync(path, { recursive: true })
  if (!existsSync(path)) throw new Error('目录创建失败：' + String(kind))
  if (process.platform !== 'win32') throw new Error('当前平台不支持打开目录')
  // Do not pass windowsHide here: Explorer is a GUI process. Some builds
  // interpret CREATE_NO_WINDOW as a hidden launch and show no window.
  const child = spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' })
  child.on('error', () => { /* the path is returned to the UI as fallback */ })
  child.unref()
  return path
}

async function saveUploadedFile(req, requestedName) {
  const root = resolve(resolveAmsHome())
  const rawName = basename(String(requestedName || 'upload.bin')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180) || 'upload.bin'
  const id = randomBytes(8).toString('hex')
  const dir = resolve(root, 'projects', 'imports', 'unscoped', id)
  if (dir !== root && !dir.startsWith(root + sep)) throw new Error('上传目录不在 AMS data 内')
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, rawName)
  const out = createWriteStream(dest)
  await new Promise((resolvePromise, reject) => {
    req.on('error', reject)
    out.on('error', reject)
    out.on('finish', resolvePromise)
    req.pipe(out)
  })
  return { path: dest, size: out.bytesWritten }
}

function connectionPath() {
  return join(resolveAmsHome(), 'config', 'connection.json')
}

function yamlQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function readConnection() {
  try { return JSON.parse(readFileSync(connectionPath(), 'utf8')) } catch { return null }
}

function applyConnection(baseUrl, apiKey) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') throw new Error('网址不能为空')
  if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new Error('Key 不能为空')
  const dataRoot = resolveAmsHome()
  const dshHome = join(dataRoot, 'kernel', 'dsh')
  const profile = join(dshHome, 'profiles', 'desktop')
  mkdirSync(join(dataRoot, 'config'), { recursive: true })
  mkdirSync(profile, { recursive: true })
  const config = { base_url: baseUrl.trim(), api_key: apiKey.trim() }
  writeFileSync(connectionPath(), JSON.stringify(config, null, 2), 'utf8')
  writeFileSync(join(dshHome, '.credentials.yaml'), 'version: 1\nrefs:\n  AMS_API_KEY: ' + yamlQuote(config.api_key) + '\n', 'utf8')
  const patchPath = join(profile, 'cordis.patch.yml')
  let patch = ''
  try { patch = readFileSync(patchPath, 'utf8') } catch { /* new profile */ }
  const block = "- id: llm-deepseek-ams\n  name: '@deepseek-ai/dsh-llm-deepseek-api-key'\n  config:\n    baseURL: " + yamlQuote(config.base_url) + '\n    apiKeyEnv: AMS_API_KEY\n'
  if (patch.indexOf('id: llm-deepseek-ams') >= 0) {
    const start = patch.indexOf('- id: llm-deepseek-ams')
    const tail = patch.slice(start + 1)
    const next = tail.indexOf('\n- ')
    const end = next >= 0 ? start + 1 + next : patch.length
    patch = patch.slice(0, start) + block.trimEnd() + patch.slice(end)
  } else {
    if (patch !== '' && !patch.endsWith('\n')) patch += '\n'
    patch += block
  }
  writeFileSync(patchPath, patch, 'utf8')
  return config
}

/** Read the Gateway endpoint and Bearer token from AMS_HOME/runtime. */
function readGatewayInfo() {
  const home = resolveAmsHome()
  const ports = JSON.parse(readFileSync(join(home, 'runtime', 'ports.json'), 'utf8'))
  const gateway = ports.gateway || {}
  const token = readFileSync(join(home, 'runtime', 'gateway.token'), 'utf8').trim()
  const prefix = gateway.api_prefix || '/api/v1'
  const host = gateway.host || '127.0.0.1'
  const port = gateway.port
  if (!Number.isInteger(port) || port <= 0) throw new Error('AMS Gateway port is not ready: ' + home)
  return { home, base: 'http://' + host + ':' + String(port) + prefix, token }
}

/** Call one Gateway endpoint and return parsed JSON. */
async function gatewayRequest(path, options) {
  const info = readGatewayInfo()
  const init = Object.assign({ method: 'GET' }, options || {})
  const headers = Object.assign({ authorization: 'Bearer ' + info.token }, init.headers || {})
  init.headers = headers
  const response = await fetch(info.base + path, init)
  const text = await response.text()
  let body = null
  if (text !== '') { try { body = JSON.parse(text) } catch { body = { raw: text } } }
  if (!response.ok) {
    const detail = body && body.error
      ? ' ' + String(body.error.code || '') + ': ' + String(body.error.message || '')
      : ''
    const error = new Error('Gateway HTTP ' + String(response.status) + ' ' + path + detail)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}

function gatewayHealth() { return gatewayRequest('/health') }
function gatewayJobs(limit) { return gatewayRequest('/jobs?limit=' + String(limit)) }
function gatewayVoices() { return gatewayRequest('/voices') }
function gatewayTtsGsvVoices() { return gatewayRequest('/tts/gsv/voices') }
function gatewayTtsGsvStatus() { return gatewayRequest('/tts/gsv/status') }
function gatewayJob(jobId) { return gatewayRequest('/jobs/' + encodeURIComponent(jobId)) }
function gatewayArtifacts(jobId) { return gatewayRequest('/jobs/' + encodeURIComponent(jobId) + '/artifacts') }
function gatewayCancel(jobId) {
  return gatewayRequest('/jobs/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST' })
}

function gatewayImportAsset(sourcePath, projectId) {
  return gatewayRequest('/projects/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source_path: sourcePath, project_id: projectId || null })
  })
}

function gatewaySubmit(type, params, projectId) {
  return gatewayRequest('/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, params: params || {}, project_id: projectId || null })
  })
}

/** Write a JSON response. */
function sendJson(res, status, value, extraHeaders) {
  const text = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  if (extraHeaders) { for (const key of Object.keys(extraHeaders)) res.setHeader(key, extraHeaders[key]) }
  res.end(text)
}

/** Read a bounded JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Build one model-facing text payload. */
function textResult(text) { return [{ type: 'text', text }] }

/** Constant-time string comparison; length mismatch still burns a comparison. */
function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length) { timingSafeEqual(a, Buffer.alloc(a.length)); return false }
  return timingSafeEqual(a, b)
}

/** Parse a Cookie header into a plain map (no decode failures thrown). */
function parseCookies(header) {
  const result = {}
  if (typeof header !== 'string' || header === '') return result
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    if (key === '') continue
    try { result[key] = decodeURIComponent(part.slice(index + 1).trim()) } catch { result[key] = part.slice(index + 1).trim() }
  }
  return result
}

/** Drop expired sessions and keep the store bounded. */
function pruneSessions(now) {
  for (const [token, record] of sessions) { if (record.expiresAt <= now) sessions.delete(token) }
  while (sessions.size >= SESSION_MAX) {
    const first = sessions.keys().next()
    if (first.done) break
    sessions.delete(first.value)
  }
}

/** Issue one browser session token and remember it. */
function issueSession(now) {
  pruneSessions(now)
  const token = randomBytes(32).toString('base64url')
  sessions.set(token, { createdAt: now, expiresAt: now + SESSION_TTL_MS, lastSeen: now })
  return token
}

/** Check one browser session token; expired tokens are removed. */
function validSession(token, now) {
  if (typeof token !== 'string' || token === '') return false
  const record = sessions.get(token)
  if (record === undefined) return false
  if (record.expiresAt <= now) { sessions.delete(token); return false }
  record.lastSeen = now
  return true
}

/** Extract the Bearer token from an Authorization header, if present. */
function bearerOf(req) {
  const raw = String(req.headers.authorization || '')
  if (!raw.startsWith('Bearer ')) return undefined
  return raw.slice('Bearer '.length).trim()
}

/** Verify a machine credential against the Gateway token (constant time). */
function gatewayTokenValid(token) {
  if (typeof token !== 'string' || token === '') return false
  try { return constantTimeEqual(token, readGatewayInfo().token) } catch { return false }
}

/** Host header hostname, normalizing IPv6 brackets. */
function hostnameOf(hostHeader) {
  const value = String(hostHeader || '').toLowerCase()
  if (value === '') return ''
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end > 0 ? value.slice(0, end + 1) : value
  }
  const index = value.indexOf(':')
  return index < 0 ? value : value.slice(0, index)
}

/** Require a loopback Host header; rejects DNS-rebinding style hosts. */
function loopbackHost(hostHeader) {
  return LOOPBACK_HOSTS.has(hostnameOf(hostHeader))
}

/** Same-origin gate for issuing browser sessions. */
function sameOriginRequest(req) {
  const host = String(req.headers.host || '')
  if (!loopbackHost(host)) return false
  const fetchSite = String(req.headers['sec-fetch-site'] || '')
  if (fetchSite !== '' && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try { const url = new URL(origin); return url.host === host || url.hostname === hostnameOf(host) } catch { return false }
  }
  const referer = req.headers.referer
  if (typeof referer === 'string' && referer !== '') {
    try { const url = new URL(referer); return url.host === host || url.hostname === hostnameOf(host) } catch { return false }
  }
  return true
}

/** Resolve the caller credential kind: bearer | session | none. */
function authKind(req) {
  if (gatewayTokenValid(bearerOf(req))) return 'bearer'
  const cookies = parseCookies(req.headers.cookie)
  if (validSession(cookies[SESSION_COOKIE], Date.now())) return 'session'
  // Some Chromium/WebView configurations drop or partition cookies for local
  // loopback pages. A same-origin loopback request is still a trusted local
  // page, so allow it as a fallback after the stronger bearer/session checks.
  if (sameOriginRequest(req)) return 'same-origin'
  return 'none'
}

/** 401 response for a missing/invalid credential. */
function sendUnauthorized(res, requestPath) {
  sendJson(res, 401, {
    ok: false,
    error: { code: 'AMS_UNAUTHORIZED', message: 'Missing or invalid credential for ' + requestPath }
  }, {
    'www-authenticate': 'Bearer realm="ams", error="invalid_token"'
  })
}

/** Pipe one Gateway SSE stream to the browser response. */
async function pipeEvents(req, res, jobId) {
  const info = readGatewayInfo()
  const headers = { authorization: 'Bearer ' + info.token, accept: 'text/event-stream' }
  const lastEventId = req.headers['last-event-id']
  if (typeof lastEventId === 'string' && lastEventId !== '') headers['last-event-id'] = lastEventId
  const upstream = await fetch(info.base + '/jobs/' + encodeURIComponent(jobId) + '/events', { headers })
  res.statusCode = upstream.status
  res.setHeader('content-type', upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-accel-buffering', 'no')
  if (!upstream.ok) {
    res.end('event: error\ndata: {"code":"AMS_UPSTREAM_ERROR","status":' + String(upstream.status) + '}\n\n')
    return
  }
  const reader = upstream.body.getReader()
  let closed = false
  let heartbeat = null
  const close = () => {
    if (closed) return
    closed = true
    if (heartbeat !== null) clearInterval(heartbeat)
    try { reader.cancel() } catch { /* the upstream body may already be gone */ }
  }
  heartbeat = setInterval(() => {
    if (closed) return
    try { res.write(': keepalive\n\n') } catch { close() }
  }, SSE_HEARTBEAT_MS)
  req.on('close', close)
  res.on('close', close)
  try {
    while (!closed) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (chunk.value !== undefined && !closed) res.write(Buffer.from(chunk.value))
    }
  } catch {
    // Upstream disconnect: close the browser stream so EventSource reconnects.
  } finally {
    close()
    try { res.end() } catch { /* response may already be destroyed */ }
  }
}

/** Build the UI summary payload. */
async function summaryPayload(auth) {
  const info = readGatewayInfo()
  const result = { plugin: '@ams/plugin-core', pluginVersion: PLUGIN_VERSION, time: new Date().toISOString(), auth, tools: TOOL_NAMES, gateway: { ok: false, base: info.base }, jobs: [], jobListError: null }
  try {
    const health = await gatewayHealth()
    result.gateway = { ok: true, base: info.base, status: String(health.status || 'ok'), version: health.version || null, job_types: health.job_types || null }
    result.jobTypes = Array.isArray(health.job_types) ? health.job_types : []
  } catch (error) {
    result.gateway.error = String(error && error.message ? error.message : error)
  }
  try {
    const list = await gatewayJobs(20)
    result.jobs = Array.isArray(list) ? list : (Array.isArray(list.data) ? list.data : (Array.isArray(list.jobs) ? list.jobs : []))
  } catch (error) {
    result.jobListError = String(error && error.message ? error.message : error)
  }
  return result
}

export function apply(ctx) {
  const logger = ctx.logger
  const log = (message) => { if (logger && typeof logger.info === 'function') logger.info(message); else console.log('[ams-plugin-core] ' + message) }

  const pingTool = defineTool({
    name: 'music_ping',
    description: 'Check the AMS plugin and local Gateway wiring. Returns plugin version, current time, and Gateway health.',
    parameters: {
      note: { type: 'string', description: 'Optional note echoed back for callers.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          plugin: { type: 'string', required: true },
          pluginVersion: { type: 'string', required: true },
          time: { type: 'string', required: true },
          gatewayBase: { type: 'string', required: true },
          gatewayStatus: { type: 'string', required: true },
          note: { type: 'string' }
        }
      },
      render: (_args, value) => textResult('[music_ping] ok=' + String(value.ok) + ' gateway=' + value.gatewayStatus + ' at ' + value.time)
    },
    async execute(args) {
      const info = readGatewayInfo()
      let gatewayStatus = 'unknown'
      try { const health = await gatewayHealth(); gatewayStatus = String(health && health.status ? health.status : 'ok') } catch (error) { gatewayStatus = 'error: ' + String(error && error.message ? error.message : error) }
      return {
        ok: gatewayStatus === 'ok',
        plugin: '@ams/plugin-core',
        pluginVersion: PLUGIN_VERSION,
        time: new Date().toISOString(),
        gatewayBase: info.base,
        gatewayStatus,
        ...(typeof args.note === 'string' ? { note: args.note } : {})
      }
    }
  })

  const submitTool = defineTool({
    name: 'music_job_submit',
    description: 'Submit an AMS Gateway job. Supported types: ping, mock.long, convert.msvc (song re-voicing), convert.rvc (voice conversion), separate.pymss (vocal separation), train.rvc (voice model training). For convert/separate/train pass the backend params (input_path, output_dir, model, voice, pitch, f0_method, index_path, dataset_dir, epochs, ...) or an extra params object. Returns the Gateway job id; the Gateway decides which types are currently available.',
    parameters: {
      type: { type: 'string', required: true, enum: ['ping', 'mock.long', 'convert.msvc', 'convert.rvc', 'separate.pymss', 'train.rvc'], description: 'Gateway job type.' },
      input_path: { type: 'string', description: 'Input audio / dataset path for convert and separate jobs.' },
      output_dir: { type: 'string', description: 'Output directory hint for the backend.' },
      model: { type: 'string', description: 'Model id/name or .pth path (convert.msvc / convert.rvc).' },
      voice: { type: 'string', description: 'Target voice name (convert.rvc / convert.msvc).' },
      index_path: { type: 'string', description: 'Optional .index path for RVC voice conversion.' },
      dataset_dir: { type: 'string', description: 'Training dataset directory (train.rvc).' },
      pitch: { type: 'integer', description: 'Pitch shift in semitones (-24..24).' },
      f0_method: { type: 'string', enum: ['rmvpe', 'harvest', 'pm', 'crepe'], description: 'F0 extraction method for voice conversion.' },
      epochs: { type: 'integer', description: 'Training epochs (train.rvc).' },
      batch_size: { type: 'integer', description: 'Training batch size (train.rvc).' },
      sample_rate: { type: 'integer', description: 'Target sample rate, e.g. 40000 / 48000.' },
      seconds: { type: 'number', description: 'mock.long duration in seconds (0.2-300).' },
      params: { type: 'json', description: 'Extra Gateway params merged into the request (advanced).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          job_id: { type: 'string', required: true },
          type: { type: 'string', required: true },
          status: { type: 'string', required: true },
          created_at: { type: 'string' }
        }
      },
      render: (_args, value) => textResult('Submitted Gateway job ' + value.job_id + ' (' + value.type + '), status=' + value.status)
    },
    async execute(args) {
      const params = {}
      const copyKeys = ['input_path', 'output_dir', 'model', 'voice', 'index_path', 'dataset_dir', 'pitch', 'f0_method', 'epochs', 'batch_size', 'sample_rate', 'seconds']
      for (const key of copyKeys) { if (args[key] !== undefined && args[key] !== null) params[key] = args[key] }
      if (args.params !== undefined && args.params !== null && typeof args.params === 'object') {
        for (const key of Object.keys(args.params)) params[key] = args.params[key]
      }
      const job = await gatewaySubmit(args.type, params)
      const jobId = String(job && job.id ? job.id : '')
      if (jobId === '') throw new Error('Gateway response did not include a job id')
      return {
        job_id: jobId,
        type: String(job.type || args.type),
        status: String(job.status || 'queued'),
        ...(typeof job.created_at === 'string' ? { created_at: job.created_at } : {})
      }
    }
  })

  const statusTool = defineTool({
    name: 'music_job_status',
    description: 'Read one AMS Gateway job by id (status/progress/stage/error).',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Gateway job id returned by music_job_submit.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          type: { type: 'string', required: true },
          status: { type: 'string', required: true },
          progress: { type: 'number' },
          stage: { type: 'string' },
          error: { type: 'string' }
        }
      },
      render: (_args, value) => textResult('Job ' + value.id + ': ' + value.status + ' progress=' + String(value.progress) + (value.stage ? ' stage=' + value.stage : ''))
    },
    async execute(args) {
      const job = await gatewayJob(args.job_id)
      return {
        id: String(job.id),
        type: String(job.type),
        status: String(job.status),
        ...(typeof job.progress === 'number' ? { progress: job.progress } : {}),
        ...(typeof job.stage === 'string' ? { stage: job.stage } : {}),
        ...(job.error ? { error: String(job.error) } : {})
      }
    }
  })

  const listTool = defineTool({
    name: 'music_job_list',
    description: 'List recent AMS Gateway jobs, optionally filtered by status or type. Returns job summaries (id/type/status/progress/stage) newest first.',
    parameters: {
      status: { type: 'string', enum: ['queued', 'running', 'stopping', 'succeeded', 'failed', 'cancelled'], description: 'Optional status filter.' },
      type: { type: 'string', description: 'Optional job type filter, e.g. convert.rvc.' },
      limit: { type: 'integer', description: 'Max jobs to return (1-50, default 20).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobs: { type: 'array', required: true, items: { type: 'json' } },
          total: { type: 'integer' }
        }
      },
      render: (_args, value) => textResult('Gateway jobs: ' + String(value.jobs.length) + ' returned, ' + String(value.total) + ' total')
    },
    async execute(args) {
      const search = []
      if (typeof args.status === 'string') search.push('status=' + encodeURIComponent(args.status))
      if (typeof args.type === 'string') search.push('type=' + encodeURIComponent(args.type))
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20
      search.push('limit=' + String(limit))
      const list = await gatewayRequest('/jobs?' + search.join('&'))
      const jobs = Array.isArray(list.data) ? list.data : (Array.isArray(list) ? list : [])
      const total = typeof list.total === 'number' ? list.total : jobs.length
      return { jobs, total }
    }
  })

  const cancelTool = defineTool({
    name: 'music_job_cancel',
    description: 'Cancel one AMS Gateway job by id. A queued job is cancelled immediately; a running job goes stopping -> cancelled (the Gateway kills its process tree).',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Gateway job id.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          error: { type: 'string' }
        }
      },
      render: (_args, value) => textResult('Cancel requested for ' + value.id + ', current status=' + value.status)
    },
    async execute(args) {
      const job = await gatewayCancel(args.job_id)
      return {
        id: String(job.id),
        status: String(job.status),
        ...(job.error ? { error: String(job.error) } : {})
      }
    }
  })

  ctx.effect(() => ctx.tools.register(pingTool), 'ams-plugin-core: music_ping')
  ctx.effect(() => ctx.tools.register(submitTool), 'ams-plugin-core: music_job_submit')
  ctx.effect(() => ctx.tools.register(statusTool), 'ams-plugin-core: music_job_status')
  ctx.effect(() => ctx.tools.register(listTool), 'ams-plugin-core: music_job_list')
  ctx.effect(() => ctx.tools.register(cancelTool), 'ams-plugin-core: music_job_cancel')
  log('registered tools: ' + TOOL_NAMES.join(', '))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        const pathname = new URL(String(req.url), 'http://localhost').pathname
        const parts = pathname.split('/').filter(part => part !== '')
        if (parts[0] !== 'ams' || parts[1] !== 'api') { sendJson(res, 404, { ok: false, error: { code: 'AMS_NOT_FOUND', message: 'unknown route: ' + pathname } }); return }
        const rest = parts.slice(2)
        const requestPath = ROUTE_PREFIX + (rest.length > 0 ? '/' + rest.join('/') : '')

        // Only unauthenticated endpoint: browser session bootstrap.
        if (rest.length === 1 && rest[0] === 'session') {
          if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: { code: 'AMS_METHOD_NOT_ALLOWED', message: 'GET only' } }); return }
          if (!sameOriginRequest(req)) {
            log('session denied (cross-origin or non-loopback host) host=' + String(req.headers.host || '') + ' origin=' + String(req.headers.origin || ''))
            sendJson(res, 403, { ok: false, error: { code: 'AMS_CROSS_ORIGIN', message: 'session issuance requires a loopback same-origin request' } })
            return
          }
          const token = issueSession(Date.now())
          const cookie = SESSION_COOKIE + '=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + String(Math.floor(SESSION_TTL_MS / 1000))
          sendJson(res, 200, { ok: true, auth: 'session', expiresInSec: Math.floor(SESSION_TTL_MS / 1000), cookie: SESSION_COOKIE }, { 'set-cookie': cookie })
          return
        }

        // Everything else requires bearer token or a valid browser session.
        const auth = authKind(req)
        if (auth === 'none') { sendUnauthorized(res, requestPath); return }

        const joined = rest.join('/')
        if (joined === 'connection' && req.method === 'GET') {
          const config = readConnection()
          sendJson(res, 200, { ok: true, base_url: config ? String(config.base_url || '') : '', has_api_key: Boolean(config && config.api_key), configured: Boolean(config && config.base_url && config.api_key) })
          return
        }
        if (joined === 'connection' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const config = applyConnection(body && body.base_url, body && body.api_key)
            sendJson(res, 200, { ok: true, base_url: config.base_url, has_api_key: true, configured: true, message: '已保存；重启 AMS Kernel 后生效' })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: { code: 'AMS_CONNECTION_INVALID', message: String(error && error.message ? error.message : error) } })
          }
          return
        }
        if (joined === 'summary' && req.method === 'GET') { sendJson(res, 200, await summaryPayload(auth)); return }
        if (joined === 'voices' && req.method === 'GET') { sendJson(res, 200, await gatewayVoices()); return }
        if (joined === 'voice-preview' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const preview = await previewVoice(body)
            sendJson(res, 200, { ok: true, data: preview })
          } catch (error) { sendJson(res, 500, { ok: false, error: { code: 'VOICE_PREVIEW_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }

        if (joined.startsWith('job-artifacts/') && req.method === 'GET') {
          try {
            const jobId = joined.slice('job-artifacts/'.length)
            if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('非法 job id')
            const list = await gatewayArtifacts(jobId)
            sendJson(res, 200, { ok: true, data: Array.isArray(list.data) ? list.data : (Array.isArray(list) ? list : []) })
          } catch (error) { sendJson(res, 404, { ok: false, error: { code: 'JOB_ARTIFACTS_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'audio' && req.method === 'GET') {
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            const file = resolveAmsHome()
            const candidate = resolve(String(url.searchParams.get('path') || ''))
            const root = resolve(file)
            if (!candidate.startsWith(root + sep)) throw new Error('路径不在 AMS_HOME')
            if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new Error('音频不存在')
            const buffer = readFileSync(candidate)
            res.statusCode = 200
            res.setHeader('content-type', 'audio/wav')
            res.setHeader('content-length', String(buffer.length))
            res.end(buffer)
          } catch (error) { sendJson(res, 404, { ok: false, error: { code: 'AUDIO_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'job-export' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const jobId = String(body.job_id || '')
            if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('非法 job id')
            const list = await gatewayArtifacts(jobId)
            const artifacts = Array.isArray(list.data) ? list.data : (Array.isArray(list) ? list : [])
            const audio = artifacts.find(entry => String(entry.kind || '').indexOf('audio') >= 0 || String(entry.name || '').toLowerCase().endsWith('.wav'))
            if (!audio || !audio.path) throw new Error('没有可导出的音频产物')
            const dir = join(resolveAmsHome(), 'exports', 'songs')
            mkdirSync(dir, { recursive: true })
            const target = join(dir, jobId + '-' + basename(audio.name))
            cpSync(audio.path, target)
            sendJson(res, 200, { ok: true, data: { path: target, name: basename(target) } })
          } catch (error) { sendJson(res, 400, { ok: false, error: { code: 'JOB_EXPORT_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined.startsWith('job-audio/') && req.method === 'GET') {
          try {
            const jobId = joined.slice('job-audio/'.length)
            if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('非法 job id')
            const list = await gatewayArtifacts(jobId)
            const artifacts = Array.isArray(list.data) ? list.data : (Array.isArray(list) ? list : [])
            const audio = artifacts.find(entry => String(entry.kind || '').indexOf('audio') >= 0 || String(entry.name || '').toLowerCase().endsWith('.wav'))
            if (!audio || !audio.id) throw new Error('该任务没有音频产物')
            const info = readGatewayInfo()
            const upstream = await fetch(info.base + '/artifacts/' + encodeURIComponent(audio.id) + '/download', { headers: { authorization: 'Bearer ' + info.token } })
            if (!upstream.ok) throw new Error('artifact HTTP ' + upstream.status)
            const buffer = Buffer.from(await upstream.arrayBuffer())
            res.statusCode = 200
            res.setHeader('content-type', 'audio/wav')
            res.setHeader('content-length', String(buffer.length))
            res.end(buffer)
          } catch (error) { sendJson(res, 404, { ok: false, error: { code: 'JOB_AUDIO_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined.startsWith('artifact/') && req.method === 'GET') {
          try {
            const id = joined.slice('artifact/'.length)
            if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('非法 artifact id')
            const info = readGatewayInfo()
            const upstream = await fetch(info.base + '/artifacts/' + encodeURIComponent(id) + '/download', { headers: { authorization: 'Bearer ' + info.token } })
            if (!upstream.ok) throw new Error('artifact HTTP ' + upstream.status)
            const buffer = Buffer.from(await upstream.arrayBuffer())
            res.statusCode = 200
            res.setHeader('content-type', 'audio/wav')
            res.setHeader('content-length', String(buffer.length))
            res.end(buffer)
          } catch (error) { sendJson(res, 404, { ok: false, error: { code: 'ARTIFACT_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'datasets' && req.method === 'GET') { sendJson(res, 200, { ok: true, data: listDatasets() }); return }
        if (joined === 'dataset-rename' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const oldName = String(body.name || ''); const newName = String(body.new_name || '')
            if (!oldName || !newName || oldName.startsWith('_') || newName.startsWith('_')) throw new Error('非法名称')
            const root = join(resolveAmsHome(), 'datasets'); const from = join(root, oldName); const to = join(root, newName)
            if (!existsSync(from) || existsSync(to)) throw new Error('源不存在或目标已存在')
            renameSync(from, to)
            const metaPath = join(to, 'dataset.json')
            try { const meta = JSON.parse(readFileSync(metaPath, 'utf8')); meta.name = newName; meta.updated_at = new Date().toISOString(); writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8') } catch { /* no dataset.json */ }
            sendJson(res, 200, { ok: true, data: { name: newName } })
          } catch (error) { sendJson(res, 400, { ok: false, error: { code: 'DATASET_RENAME_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'dataset-trash' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const name = String(body.name || '')
            if (!name || name.startsWith('_')) throw new Error('非法名称')
            const from = join(resolveAmsHome(), 'datasets', name)
            if (!existsSync(from)) throw new Error('数据集不存在')
            moveToTrash(from, 'datasets')
            sendJson(res, 200, { ok: true, data: { name } })
          } catch (error) { sendJson(res, 400, { ok: false, error: { code: 'DATASET_TRASH_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'schemas' && req.method === 'GET') {
          const dir = join(resolveAmsHome(), 'config', 'schemas')
          const result = {}
          try {
            for (const entry of readdirSync(dir)) {
              if (!entry.endsWith('.json')) continue
              try { result[entry.slice(0, -5)] = JSON.parse(readFileSync(join(dir, entry), 'utf8')) } catch { /* skip */ }
            }
          } catch { /* none */ }
          sendJson(res, 200, { ok: true, data: result })
          return
        }
        if (joined === 'templates' && req.method === 'GET') { sendJson(res, 200, { ok: true, data: listTemplates() }); return }
        if (joined === 'templates' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const saved = saveTemplate(String(body.kind || ''), String(body.name || ''), body.params || {})
            sendJson(res, 200, { ok: true, data: saved })
          } catch (error) { sendJson(res, 400, { ok: false, error: { code: 'TEMPLATE_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'templates' && req.method === 'DELETE') {
          try {
            const body = await readJsonBody(req)
            const file = templatePath(String(body.kind || ''), String(body.name || ''))
            if (!existsSync(file)) throw new Error('模板不存在')
            const dest = moveToTrash(file, 'templates')
            sendJson(res, 200, { ok: true, data: { path: dest } })
          } catch (error) { sendJson(res, 400, { ok: false, error: { code: 'TEMPLATE_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'voice-meta' && req.method === 'GET') {
          const root = join(resolveAmsHome(), 'voices')
          const voices = []
          try {
            for (const entry of readdirSync(root)) {
              if (entry.startsWith('.')) continue
              const full = join(root, entry)
              if (!statSync(full).isDirectory()) continue
              voices.push(readVoiceMetadata(entry))
            }
          } catch { /* no voices */ }
          sendJson(res, 200, { ok: true, data: { voices } })
          return
        }
        if (joined === 'voice-meta' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const name = safeVoiceName(body.name)
            const dir = join(resolveAmsHome(), 'voices', name)
            if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('音色不存在')
            const previous = readVoiceMetadata(name)
            const next = Object.assign({}, previous, {
              name,
              tags: Array.isArray(body.tags) ? body.tags.map(item => String(item).trim()).filter(Boolean).slice(0, 20) : previous.tags,
              note: typeof body.note === 'string' ? body.note.slice(0, 2000) : previous.note,
              favorite: typeof body.favorite === 'boolean' ? body.favorite : previous.favorite,
              updated_at: new Date().toISOString()
            })
            const file = join(dir, 'voice.json')
            const tmp = file + '.tmp'
            writeFileSync(tmp, JSON.stringify(next, null, 2))
            renameSync(tmp, file)
            sendJson(res, 200, { ok: true, data: next })
          } catch (error) { sendJson(res, 400, { ok: false, error: { code: 'VOICE_META_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'voice-import' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const imported = importVoicepack(String(body.archive_path || ''), String(body.name || ''))
            sendJson(res, 200, { ok: true, data: imported })
          } catch (error) { sendJson(res, 400, { ok: false, error: { code: 'VOICE_IMPORT_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'voice-export' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const path = exportVoicepack(String(body.name || ''))
            sendJson(res, 200, { ok: true, data: { path } })
          } catch (error) { sendJson(res, 400, { ok: false, error: { code: 'VOICE_EXPORT_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'voice-index' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const name = safeVoiceName(body.name)
            const dir = join(resolveAmsHome(), 'voices', name)
            if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('音色不存在')
            const target = join(dir, name + '.index')
            if (body.index_path) {
              const source = String(body.index_path)
              if (!source.toLowerCase().endsWith('.index') || !existsSync(source)) throw new Error('index 文件不存在或扩展名错误')
              if (existsSync(target)) moveToTrash(target, 'indexes')
              const tmp = target + '.tmp'
              writeFileSync(tmp, readFileSync(source))
              renameSync(tmp, target)
            } else if (existsSync(target)) {
              moveToTrash(target, 'indexes')
            }
            const meta = readVoiceMetadata(name)
            meta.index_bound = Boolean(body.index_path) && existsSync(target)
            meta.updated_at = new Date().toISOString()
            const file = join(dir, 'voice.json')
            const tmp = file + '.tmp'
            writeFileSync(tmp, JSON.stringify(meta, null, 2))
            renameSync(tmp, file)
            sendJson(res, 200, { ok: true, data: { name, index_bound: meta.index_bound } })
          } catch (error) { sendJson(res, 400, { ok: false, error: { code: 'VOICE_INDEX_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'voice-trash' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const name = safeVoiceName(body.name)
            const source = join(resolveAmsHome(), 'voices', name)
            if (!existsSync(source)) throw new Error('音色不存在')
            const dest = moveToTrash(source, 'voices')
            sendJson(res, 200, { ok: true, data: { path: dest } })
          } catch (error) { sendJson(res, 400, { ok: false, error: { code: 'VOICE_TRASH_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'tts-gsv/voices' && req.method === 'GET') { sendJson(res, 200, await gatewayTtsGsvVoices()); return }
        if (joined === 'tts-gsv/status' && req.method === 'GET') { sendJson(res, 200, await gatewayTtsGsvStatus()); return }
        if (joined === 'health' && req.method === 'GET') { sendJson(res, 200, await gatewayHealth()); return }
        if (joined === 'open-folder' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const kind = body && typeof body.kind === 'string' ? body.kind : ''
            const path = openDataFolder(kind)
            sendJson(res, 200, { ok: true, kind, path, message: '已打开数据目录' })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: { code: 'AMS_OPEN_FOLDER_FAILED', message: String(error && error.message ? error.message : error) } })
          }
          return
        }
        if (joined === 'vc' || joined.startsWith('vc/')) {
          try {
            const body = req.method === 'POST' ? await readJsonBody(req) : null
            const result = await vcRequest('/' + joined, req.method, body)
            sendJson(res, result.status, result.payload)
          } catch (error) {
            sendJson(res, 502, { ok: false, error: { code: 'AMS_VC_ERROR', message: String(error && error.message ? error.message : error) } })
          }
          return
        }
        if (joined === 'upload' && req.method === 'POST') {
          try {
            const uploadName = new URL(String(req.url), 'http://localhost').searchParams.get('name') || 'upload.bin'
            const saved = await saveUploadedFile(req, uploadName)
            sendJson(res, 200, { ok: true, data: saved })
          } catch (error) {
            sendJson(res, 502, { ok: false, error: { code: 'AMS_UPLOAD_FAILED', message: String(error && error.message ? error.message : error) } })
          }
          return
        }
        if (joined === 'jobs' && req.method === 'GET') { sendJson(res, 200, await gatewayJobs(50)); return }
        if (joined === 'projects' && req.method === 'GET') { sendJson(res, 200, { ok: true, data: listProjects(resolveAmsHome()) }); return }
        if (joined === 'projects' && req.method === 'POST') {
          try { const body = await readJsonBody(req); sendJson(res, 200, { ok: true, data: createProject(resolveAmsHome(), String(body.name || '')) }) }
          catch (error) { sendJson(res, 400, { ok: false, error: { code: 'PROJECT_CREATE_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined.startsWith('projects/detail/') && req.method === 'GET') {
          try {
            const id = joined.slice('projects/detail/'.length); let meta = readProject(resolveAmsHome(), id); let jobs = []
            try { const value = await gatewayRequest('/jobs?project_id=' + encodeURIComponent(id) + '&limit=100'); jobs = Array.isArray(value.data) ? value.data : []; for (const job of jobs) appendProjectStep(resolveAmsHome(), id, job); meta = readProject(resolveAmsHome(), id) } catch { /* no jobs */ }
            sendJson(res, 200, { ok: true, data: { project: meta, jobs } })
          } catch (error) { sendJson(res, 404, { ok: false, error: { code: 'PROJECT_DETAIL_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'projects-import' && req.method === 'POST') {
          try { const body = await readJsonBody(req); sendJson(res, 200, { ok: true, data: importProject(resolveAmsHome(), String(body.archive_path || ''), String(body.name || ''), tarExe) }) }
          catch (error) { sendJson(res, 400, { ok: false, error: { code: 'PROJECT_IMPORT_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'projects-trash' && req.method === 'POST') {
          try { const body = await readJsonBody(req); trashProject(resolveAmsHome(), String(body.id || ''), moveToTrash); sendJson(res, 200, { ok: true, data: { id: body.id } }) }
          catch (error) { sendJson(res, 400, { ok: false, error: { code: 'PROJECT_TRASH_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'projects-export' && req.method === 'POST') {
          try { const body = await readJsonBody(req); const path = exportProject(resolveAmsHome(), String(body.id || ''), tarExe); sendJson(res, 200, { ok: true, data: { path } }) }
          catch (error) { sendJson(res, 400, { ok: false, error: { code: 'PROJECT_EXPORT_ERROR', message: String(error && error.message ? error.message : error) } }) }
          return
        }
        if (joined === 'projects/import' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const sourcePath = body && typeof body.source_path === 'string' ? body.source_path : ''
          if (!sourcePath) { sendJson(res, 400, { ok: false, error: { code: 'AMS_INVALID_PARAMS', message: 'source_path required' } }); return }
          sendJson(res, 200, await gatewayImportAsset(sourcePath, body && body.project_id))
          return
        }
        if (joined === 'jobs' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const type = body && typeof body.type === 'string' && body.type !== '' ? body.type : 'ping'
          const params = body && typeof body.params === 'object' && body.params !== null ? body.params : {}
          const job = await gatewaySubmit(type, params, body && body.project_id)
          if (body && body.project_id) { try { appendProjectStep(resolveAmsHome(), String(body.project_id), job); watchProjectJob(resolveAmsHome(), String(body.project_id), job.id) } catch { /* project may not exist */ } }
          sendJson(res, 201, job)
          return
        }
        if (rest.length === 3 && rest[0] === 'jobs' && rest[2] === 'events' && req.method === 'GET') {
          await pipeEvents(req, res, rest[1])
          return
        }
        if (rest.length === 3 && rest[0] === 'jobs' && rest[2] === 'cancel' && req.method === 'POST') {
          sendJson(res, 200, await gatewayCancel(rest[1]))
          return
        }
        if (rest.length === 2 && rest[0] === 'jobs' && req.method === 'GET') {
          sendJson(res, 200, await gatewayJob(rest[1]))
          return
        }
        sendJson(res, 404, { ok: false, error: { code: 'AMS_NOT_FOUND', message: 'unknown route: ' + requestPath } })
      } catch (error) {
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: { code: 'AMS_GATEWAY_ERROR', message: String(error && error.message ? error.message : error) } })
        else { try { res.end() } catch { /* response already gone */ } }
      }
    }
  }), 'ams-plugin-core: authenticated ' + ROUTE_PREFIX)
  log('registered authenticated routes: ' + ROUTE_PREFIX + '/session|summary|health|jobs|jobs/{id}|jobs/{id}/cancel|jobs/{id}/events')
}
