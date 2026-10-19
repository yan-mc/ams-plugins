#!/usr/bin/env node
/**
 * Verify the authenticated SSE passthrough of @ams/plugin-core.
 *
 * Usage: node tools/verify-sse.mjs <baseUrl> [timeoutMs]
 *   baseUrl e.g. http://127.0.0.1:39218
 *
 * Checks:
 * 1. GET /ams/api/summary without credential -> 401
 * 2. GET /ams/api/session cross-origin -> 403
 * 3. GET /ams/api/session same-origin -> 200 + HttpOnly cookie
 * 4. GET /ams/api/summary with cookie -> 200
 * 5. POST /ams/api/jobs with cookie -> 201 + job id
 * 6. GET /ams/api/jobs/{id}/events without credential -> 401
 * 7. GET /ams/api/jobs/{id}/events with cookie -> 200 text/event-stream,
 *    receives at least one status/progress event and a terminal status.
 *
 * Prints one JSON object and exits 0 when every check passes.
 */
import process from 'node:process'

const base = String(process.argv[2] || 'http://127.0.0.1:39218').replace(/\/+$/, '')
const timeoutMs = Number(process.argv[3] || 30000)
const origin = base

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

async function main() {
  const checks = {}
  let failure = null

  const unauthSummary = await fetch(base + '/ams/api/summary')
  checks.unauthSummaryStatus = unauthSummary.status

  const crossSession = await fetch(base + '/ams/api/session', {
    headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }
  })
  checks.crossOriginSessionStatus = crossSession.status

  const session = await fetch(base + '/ams/api/session', {
    headers: { origin, 'sec-fetch-site': 'same-origin' }
  })
  const setCookie = session.headers.get('set-cookie') || ''
  const cookie = setCookie.split(';')[0]
  checks.sessionStatus = session.status
  checks.sessionCookieIssued = cookie.length > 10
  checks.sessionCookieHttpOnly = /HttpOnly/i.test(setCookie)
  checks.sessionCookieSameSite = /SameSite=Strict/i.test(setCookie)

  const authSummary = await fetch(base + '/ams/api/summary', { headers: { cookie } })
  checks.authSummaryStatus = authSummary.status
  const summaryBody = await authSummary.json().catch(() => null)
  checks.authSummaryTools = summaryBody && Array.isArray(summaryBody.tools) ? summaryBody.tools : []
  checks.authSummaryAuthKind = summaryBody ? summaryBody.auth : null

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

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const events = []
    let terminal = null
    try {
      const response = await fetch(base + '/ams/api/jobs/' + encodeURIComponent(checks.jobId) + '/events', {
        headers: { cookie, accept: 'text/event-stream' },
        signal: controller.signal
      })
      checks.sseStatus = response.status
      checks.sseContentType = response.headers.get('content-type')
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
    } catch (error) {
      if (error && error.name !== 'AbortError') throw error
      checks.sseAborted = true
    } finally {
      clearTimeout(timer)
    }
    checks.sseEventCount = events.length
    checks.sseEvents = events.slice(0, 12)
    checks.terminalStatus = terminal
  }

  checks.pass = checks.unauthSummaryStatus === 401
    && checks.crossOriginSessionStatus === 403
    && checks.sessionStatus === 200
    && checks.sessionCookieIssued === true
    && checks.sessionCookieHttpOnly === true
    && checks.sessionCookieSameSite === true
    && checks.authSummaryStatus === 200
    && checks.authSummaryTools.length === 3
    && checks.authSummaryAuthKind === 'session'
    && checks.createJobStatus === 201
    && checks.jobId !== null
    && checks.unauthSseStatus === 401
    && checks.sseStatus === 200
    && typeof checks.sseContentType === 'string' && checks.sseContentType.indexOf('text/event-stream') >= 0
    && checks.sseEventCount > 0
    && checks.terminalStatus === 'succeeded'

  process.stdout.write(JSON.stringify(checks, null, 2) + '\n')
  return checks.pass ? 0 : 1
}

main().then(code => process.exit(code)).catch(error => {
  process.stderr.write('verify-sse failed: ' + String(error && error.stack ? error.stack : error) + '\n')
  process.exit(1)
})
