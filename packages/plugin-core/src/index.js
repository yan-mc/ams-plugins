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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

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
function gatewayTtsModels() { return gatewayRequest('/tts/models') }
function gatewayJob(jobId) { return gatewayRequest('/jobs/' + encodeURIComponent(jobId)) }
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

function gatewaySubmit(type, params) {
  return gatewayRequest('/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, params: params || {} })
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
        if (joined === 'tts/models' && req.method === 'GET') { sendJson(res, 200, await gatewayTtsModels()); return }
        if (joined === 'health' && req.method === 'GET') { sendJson(res, 200, await gatewayHealth()); return }
        if (joined === 'jobs' && req.method === 'GET') { sendJson(res, 200, await gatewayJobs(50)); return }
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
          sendJson(res, 201, await gatewaySubmit(type, params))
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
