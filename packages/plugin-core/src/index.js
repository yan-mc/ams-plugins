/**
 * AMS plugin-core (Host): model-facing tools + local HTTP bridge routes.
 *
 * Tools:
 * - music_ping: verifies the plugin and Gateway wiring.
 * - music_job_submit: submits a Gateway job (type=ping | mock.long), returns the job id.
 * - music_job_status: reads one Gateway job.
 *
 * Routes (consumed by @ams/plugin-ui, loopback only in this M0.6 version):
 * - GET  /ams/api/summary  -> plugin info + Gateway health + recent jobs + registered tools
 * - GET  /ams/api/health   -> Gateway /health passthrough
 * - GET  /ams/api/jobs     -> Gateway /jobs passthrough
 * - POST /ams/api/jobs     -> Gateway job creation passthrough
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'ams-plugin-core'
export const inject = ['tools', 'webServer']

const PLUGIN_VERSION = '0.1.2'
const ROUTE_PREFIX = '/ams/api'
const TOOL_NAMES = ['music_ping', 'music_job_submit', 'music_job_status']

/** Resolve AMS_HOME from the environment; fall back to the product default. */
function resolveAmsHome() {
  const fromEnv = process.env.AMS_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), 'AppData', 'Local', 'AMS')
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
    const error = new Error('Gateway HTTP ' + String(response.status) + ' ' + path)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}

/** Gateway health probe used by tools and the UI summary route. */
function gatewayHealth() { return gatewayRequest('/health') }

/** Recent Gateway jobs (newest first, server order). */
function gatewayJobs(limit) { return gatewayRequest('/jobs?limit=' + String(limit)) }

/** Submit one Gateway job. */
function gatewaySubmit(type, params) {
  return gatewayRequest('/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, params: params || {} })
  })
}

/** Write a JSON response. */
function sendJson(res, status, value) {
  const text = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
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
      try {
        const health = await gatewayHealth()
        gatewayStatus = String(health && health.status ? health.status : 'ok')
      } catch (error) {
        gatewayStatus = 'error: ' + String(error && error.message ? error.message : error)
      }
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
    description: 'Submit an AMS Gateway job. type=ping runs a fast mock job; type=mock.long runs a cancellable long mock job. Returns the Gateway job id; poll with music_job_status.',
    parameters: {
      type: { type: 'string', required: true, enum: ['ping', 'mock.long'], description: 'Gateway job type.' },
      seconds: { type: 'number', description: 'mock.long duration in seconds (0.2-300).' },
      project_id: { type: 'string', description: 'Optional AMS project id.' }
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
      if (typeof args.seconds === 'number') params.seconds = args.seconds
      const job = await gatewaySubmit(args.type, params)
      const jobId = String(job && job.id ? job.id : '')
      if (jobId === '') throw new Error('Gateway response did not include a job id')
      return {
        job_id: jobId,
        type: String(job.type || args.type),
        status: String(job.status || 'queued'),
        ...(typeof job.created_at === 'string' ? { created_at: job.created_at } : {}),
        ...(typeof args.project_id === 'string' ? { project_id: args.project_id } : {})
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
      const job = await gatewayRequest('/jobs/' + encodeURIComponent(args.job_id))
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

  ctx.effect(() => ctx.tools.register(pingTool), 'ams-plugin-core: music_ping')
  ctx.effect(() => ctx.tools.register(submitTool), 'ams-plugin-core: music_job_submit')
  ctx.effect(() => ctx.tools.register(statusTool), 'ams-plugin-core: music_job_status')
  log('registered tools: ' + TOOL_NAMES.join(', '))

  const summary = async () => {
    const info = readGatewayInfo()
    let gateway = { ok: false, base: info.base, status: 'unknown', error: null }
    let jobs = []
    let jobListError = null
    try {
      const health = await gatewayHealth()
      gateway = { ok: true, base: info.base, status: String(health.status || 'ok'), version: health.version || null, job_types: health.job_types || null }
    } catch (error) {
      gateway.error = String(error && error.message ? error.message : error)
    }
    try {
      const list = await gatewayJobs(20)
      jobs = Array.isArray(list) ? list : (Array.isArray(list.data) ? list.data : (Array.isArray(list.jobs) ? list.jobs : []))
    } catch (error) {
      jobListError = String(error && error.message ? error.message : error)
    }
    return {
      plugin: '@ams/plugin-core',
      pluginVersion: PLUGIN_VERSION,
      time: new Date().toISOString(),
      tools: TOOL_NAMES,
      gateway,
      jobs,
      jobListError
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        const pathname = new URL(String(req.url), 'http://localhost').pathname
        if (pathname === ROUTE_PREFIX + '/summary' && req.method === 'GET') {
          sendJson(res, 200, await summary())
          return
        }
        if (pathname === ROUTE_PREFIX + '/health' && req.method === 'GET') {
          sendJson(res, 200, await gatewayHealth())
          return
        }
        if (pathname === ROUTE_PREFIX + '/jobs' && req.method === 'GET') {
          sendJson(res, 200, await gatewayJobs(50))
          return
        }
        if (pathname === ROUTE_PREFIX + '/jobs' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const type = body && typeof body.type === 'string' && body.type !== '' ? body.type : 'ping'
          const params = body && typeof body.params === 'object' && body.params !== null ? body.params : {}
          sendJson(res, 201, await gatewaySubmit(type, params))
          return
        }
        sendJson(res, 404, { ok: false, error: { code: 'AMS_NOT_FOUND', message: 'unknown AMS route: ' + pathname } })
      } catch (error) {
        sendJson(res, 502, { ok: false, error: { code: 'AMS_GATEWAY_ERROR', message: String(error && error.message ? error.message : error) } })
      }
    }
  }), 'ams-plugin-core: GET/POST ' + ROUTE_PREFIX)
  log('registered routes: ' + ROUTE_PREFIX + '/summary|health|jobs')
}
