#!/usr/bin/env node
/**
 * Verify the authenticated SSE passthrough + job operations of @ams/plugin-core (M1 pages).
 *
 * Usage: node tools/verify-sse.mjs <baseUrl> [timeoutMs]
 *
 * Checks:
 * 1. unauth summary -> 401; cross-origin session -> 403
 * 2. same-origin session -> HttpOnly SameSite=Strict cookie; cookie summary -> 200 (5 tools)
 * 3. POST job convert.rvc -> Gateway unknown type passthrough (502 AMS_GATEWAY_ERROR with reason)
 * 4. POST ping -> 201; unauth SSE -> 401; SSE with cookie -> terminal succeeded
 * 5. POST mock.long + cancel -> cancelled terminal
 */
import process from 'node:process'

const base = String(process.argv[2] || 'http://127.0.0.1:39218').replace(/\/+$/, '')
const timeoutMs = Number(process.argv[3] || 30000)
const expectedTools = ['music_ping', 'music_job_submit', 'music_job_status', 'music_job_list', 'music_job_cancel']

function parseEventFrame(frame) {
  const lines = frame.split('\n')
  let event = 'message'
  const data = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

async function streamJob(jobId, cookie, maxMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), maxMs)
  const events = []
  let terminal = null
  try {
    const response = await fetch(base + '/ams/api/jobs/' + encodeURIComponent(jobId) + '/events', {
      headers: { cookie, accept: 'text/event-stream' },
      signal: controller.signal
    })
    if (!response.ok) return { status: response.status, events, terminal }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const parsed = parseEventFrame(frame)
        if (parsed) {
          events.push(parsed)
          if (parsed.event === 'status') {
            try {
              const data = JSON.parse(parsed.data)
              if (['succeeded', 'failed', 'cancelled'].indexOf(data.status) >= 0) terminal = data.status
            } catch { /* ignore malformed payload */ }
          }
        }
        if (terminal) break
        index = buffer.indexOf('\n\n')
      }
      if (terminal) break
    }
    return { status: response.status, events, terminal }
  } finally {
    clearTimeout(timer)
  }
}

async function waitFor(httpMethod, path, cookie, predicate, maxMs) {
  const started = Date.now()
  while (Date.now() - started < maxMs) {
    const response = await fetch(base + path, { method: httpMethod, headers: { cookie } })
    const body = await response.json().catch(() => null)
    if (predicate(body)) return body
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return null
}

async function main() {
  const checks = {}
  const session = await fetch(base + '/ams/api/session', { headers: { origin: base, 'sec-fetch-site': 'same-origin' } })
  const setCookie = session.headers.get('set-cookie') || ''
  const cookie = setCookie.split(';')[0]
  checks.sessionStatus = session.status
  checks.sessionCookieHttpOnly = /HttpOnly/i.test(setCookie)
  checks.sessionCookieSameSite = /SameSite=Strict/i.test(setCookie)
  checks.sessionCookieIssued = cookie.length > 10

  const unauthSummary = await fetch(base + '/ams/api/summary')
  checks.unauthSummaryStatus = unauthSummary.status
  const crossSession = await fetch(base + '/ams/api/session', { headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' } })
  checks.crossOriginSessionStatus = crossSession.status

  const authSummary = await fetch(base + '/ams/api/summary', { headers: { cookie } })
  const summaryBody = await authSummary.json().catch(() => null)
  checks.authSummaryStatus = authSummary.status
  checks.authSummaryTools = summaryBody && Array.isArray(summaryBody.tools) ? summaryBody.tools : []
  checks.authSummaryAuthKind = summaryBody ? summaryBody.auth : null
  checks.jobTypes = summaryBody && Array.isArray(summaryBody.jobTypes) ? summaryBody.jobTypes.map(item => item.type) : []

  // Convert submit passthrough: Gateway has no convert.rvc runner yet -> 502 wrapper with reason.
  const convert = await fetch(base + '/ams/api/jobs', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'convert.rvc', params: { input_path: 'F:/AMS/input/demo.wav', voice: '曼波', pitch: 0, f0_method: 'rmvpe' } })
  })
  const convertBody = await convert.json().catch(() => null)
  checks.convertSubmitStatus = convert.status
  checks.convertSubmitErrorCode = convertBody && convertBody.error ? convertBody.error.code : null
  checks.convertSubmitMessage = convertBody && convertBody.error ? String(convertBody.error.message) : ''
  checks.convertJobId = convertBody && convertBody.id ? convertBody.id : null
  if (checks.convertJobId !== null) {
    try { await fetch(base + '/ams/api/jobs/' + encodeURIComponent(checks.convertJobId) + '/cancel', { method: 'POST', headers: { cookie } }) } catch { /* best-effort cleanup */ }
  }

  // Ping job + SSE.
  const created = await fetch(base + '/ams/api/jobs', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ping', params: {} })
  })
  checks.createJobStatus = created.status
  const job = await created.json().catch(() => null)
  checks.jobId = job && job.id ? job.id : null

  if (checks.jobId !== null) {
    const unauthSse = await fetch(base + '/ams/api/jobs/' + encodeURIComponent(checks.jobId) + '/events')
    checks.unauthSseStatus = unauthSse.status
    try { await unauthSse.body.cancel() } catch { /* body may be empty */ }
    const stream = await streamJob(checks.jobId, cookie, timeoutMs)
    checks.sseStatus = stream.status
    checks.sseEventCount = stream.events.length
    checks.sseEvents = stream.events.slice(0, 12)
    checks.terminalStatus = stream.terminal
    checks.sseContentType = null
  }

  // Cancel flow: mock.long then cancel via bridge route.
  try {
    const longCreate = await fetch(base + '/ams/api/jobs', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'mock.long', params: { seconds: 30 } })
    })
    checks.longJobStatus = longCreate.status
    const longJob = await longCreate.json().catch(() => null)
    checks.longJobId = longJob && longJob.id ? longJob.id : null
    if (checks.longJobId !== null) {
      await new Promise(resolve => setTimeout(resolve, 800))
      const cancel = await fetch(base + '/ams/api/jobs/' + encodeURIComponent(checks.longJobId) + '/cancel', { method: 'POST', headers: { cookie } })
      checks.cancelStatus = cancel.status
      const cancelBody = await cancel.json().catch(() => null)
      checks.cancelBodyStatus = cancelBody ? cancelBody.status : null
      const final = await waitFor('GET', '/ams/api/summary', cookie, body => {
        const found = body && Array.isArray(body.jobs) ? body.jobs.find(item => item.id === checks.longJobId) : null
        return found && (found.status === 'cancelled' || found.status === 'failed')
      }, 15000)
      const found = final && Array.isArray(final.jobs) ? final.jobs.find(item => item.id === checks.longJobId) : null
      checks.cancelledFinalStatus = found ? found.status : null
    }
  } catch (error) {
    checks.cancelError = String(error && error.message ? error.message : error)
  }

  const toolsOk = expectedTools.every(name => checks.authSummaryTools.indexOf(name) >= 0) && checks.authSummaryTools.length === expectedTools.length
  checks.pass = checks.sessionStatus === 200
    && checks.sessionCookieIssued === true
    && checks.sessionCookieHttpOnly === true
    && checks.sessionCookieSameSite === true
    && checks.unauthSummaryStatus === 401
    && checks.crossOriginSessionStatus === 403
    && checks.authSummaryStatus === 200
    && checks.authSummaryAuthKind === 'session'
    && toolsOk
    && checks.jobTypes.indexOf('ping') >= 0
    && (checks.convertSubmitStatus === 201
      || (checks.convertSubmitStatus === 502
        && checks.convertSubmitErrorCode === 'AMS_GATEWAY_ERROR'
        && (checks.convertSubmitMessage.indexOf('UNKNOWN_JOB_TYPE') >= 0 || checks.convertSubmitMessage.indexOf('422') >= 0 || checks.convertSubmitMessage.indexOf('未知任务类型') >= 0)))
    && checks.createJobStatus === 201
    && checks.jobId !== null
    && checks.unauthSseStatus === 401
    && checks.sseStatus === 200
    && checks.sseEventCount > 0
    && checks.terminalStatus === 'succeeded'
    && checks.longJobStatus === 201
    && checks.cancelStatus === 200
    && checks.cancelledFinalStatus === 'cancelled'

  process.stdout.write(JSON.stringify(checks, null, 2) + '\n')
  return checks.pass ? 0 : 1
}

main().then(code => process.exit(code)).catch(error => {
  process.stderr.write('verify-sse failed: ' + String(error && error.stack ? error.stack : error) + '\n')
  process.exit(1)
})
