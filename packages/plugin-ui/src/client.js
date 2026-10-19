/**
 * AMS plugin-ui (Client): lazy-CJS bundle loaded by the DSH client module system.
 *
 * M1 (task-22) hardening:
 * - Bootstraps a same-origin short-lived session cookie via /ams/api/session
 *   (the Gateway token never reaches the browser).
 * - Job progress uses authenticated SSE (/ams/api/jobs/{id}/events) through
 *   EventSource instead of 1s polling; on stream failure it reconnects with
 *   backoff and degrades to 2s polling until a reconnect succeeds.
 */
window.__ModuleLoader__.load({
  id: '@ams/plugin-ui',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'ams.home'
    const SESSION_PATH = '/ams/api/session'
    const SUMMARY_PATH = '/ams/api/summary'
    const JOBS_PATH = '/ams/api/jobs'
    const TERMINAL = ['succeeded', 'failed', 'cancelled']

    const COLORS = {
      bg: 'var(--dsw-bg-app, #16181d)',
      panel: 'var(--dsw-bg-panel, #1e2128)',
      border: 'var(--dsw-border, #333842)',
      text: 'var(--dsw-text-primary, #e6e6e6)',
      muted: 'var(--dsw-text-secondary, #9aa0aa)',
      ok: '#4caf50',
      warn: '#ffb300',
      err: '#e53935',
      accent: '#5b8def'
    }

    function cardStyle(extra) {
      return Object.assign({
        background: COLORS.panel,
        border: '1px solid ' + COLORS.border,
        borderRadius: 8,
        padding: 16,
        marginBottom: 16
      }, extra || {})
    }

    function statusColor(status) {
      if (status === 'succeeded') return COLORS.ok
      if (status === 'failed' || status === 'cancelled') return COLORS.err
      if (status === 'running' || status === 'stopping') return COLORS.warn
      return COLORS.muted
    }

    function sseColor(state) {
      if (state === 'open') return COLORS.ok
      if (state === 'retrying' || state === 'connecting') return COLORS.warn
      if (state === 'fallback') return COLORS.err
      return COLORS.muted
    }

    function sseLabel(state) {
      if (state === 'open') return 'SSE 已连接'
      if (state === 'connecting') return 'SSE 连接中…'
      if (state === 'retrying') return 'SSE 重连中…'
      if (state === 'fallback') return 'SSE 不可用，降级 2s 轮询'
      if (state === 'closed') return 'SSE 已结束'
      return 'SSE 待命'
    }

    /** JSON fetch with a same-origin session bootstrap retry on 401. */
    async function fetchJson(path, options) {
      const init = Object.assign({ method: 'GET' }, options || {})
      init.credentials = 'same-origin'
      init.headers = Object.assign({ accept: 'application/json' }, init.headers || {})
      let response = await fetch(path, init)
      if (response.status === 401) {
        const session = await fetch(SESSION_PATH, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
        if (!session.ok) throw new Error('session bootstrap HTTP ' + String(session.status))
        response = await fetch(path, init)
      }
      const text = await response.text()
      let body = null
      if (text !== '') { try { body = JSON.parse(text) } catch { body = { raw: text } } }
      if (!response.ok) {
        const error = new Error('HTTP ' + String(response.status))
        error.body = body
        throw error
      }
      return body
    }

    /** Ensure the browser holds a fresh session cookie (idempotent). */
    async function ensureSession() {
      const response = await fetch(SESSION_PATH, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
      const text = await response.text()
      if (!response.ok) throw new Error('session bootstrap HTTP ' + String(response.status) + ' ' + text.slice(0, 160))
      return JSON.parse(text || '{}')
    }

    /** Fold one SSE event payload into the job list snapshot. */
    function applyEvent(previous, jobId, data) {
      if (!previous || !Array.isArray(previous.jobs)) return previous
      const jobs = previous.jobs.map(job => {
        if (job.id !== jobId) return job
        const next = Object.assign({}, job)
        if (data && typeof data.status === 'string') next.status = data.status
        if (data && typeof data.progress === 'number') next.progress = data.progress
        if (data && typeof data.stage === 'string') next.stage = data.stage
        if (data && data.error !== undefined && data.error !== null) next.error = data.error
        return next
      })
      return Object.assign({}, previous, { jobs })
    }

    function useAmsConsole() {
      const [summary, setSummary] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [updatedAt, setUpdatedAt] = React.useState(null)
      const [sseState, setSseState] = React.useState('idle')
      const [lastEvent, setLastEvent] = React.useState(null)
      const [watched, setWatched] = React.useState(null)
      const [reconnectNonce, setReconnectNonce] = React.useState(0)
      const mounted = React.useRef(true)
      const esRef = React.useRef(null)
      const retryRef = React.useRef(0)
      const retryTimer = React.useRef(null)

      const refresh = React.useCallback(async () => {
        try {
          const data = await fetchJson(SUMMARY_PATH)
          if (!mounted.current) return
          setSummary(data)
          setError(null)
          setLoading(false)
          setUpdatedAt(new Date().toLocaleTimeString())
          const jobs = Array.isArray(data.jobs) ? data.jobs : []
          const active = jobs.find(job => job.status === 'running' || job.status === 'queued' || job.status === 'stopping')
          const target = active ? active.id : (jobs[0] ? jobs[0].id : null)
          setWatched(previous => previous === target ? previous : target)
        } catch (err) {
          if (!mounted.current) return
          setError(String(err && err.message ? err.message : err))
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        mounted.current = true
        ensureSession().then(refresh).catch(() => {
          ensureSession().then(refresh).catch(err => {
            if (mounted.current) { setError(String(err && err.message ? err.message : err)); setLoading(false) }
          })
        })
        return () => { mounted.current = false }
      }, [refresh])

      React.useEffect(() => {
        if (watched === null || watched === undefined || watched === '') return undefined
        let disposed = false
        const closeSource = () => {
          if (esRef.current !== null) { try { esRef.current.close() } catch { /* already closed */ } esRef.current = null }
          if (retryTimer.current !== null) { clearTimeout(retryTimer.current); retryTimer.current = null }
        }
        const connect = () => {
          if (disposed) return
          closeSource()
          setSseState('connecting')
          let source
          try {
            source = new EventSource('/ams/api/jobs/' + encodeURIComponent(watched) + '/events', { withCredentials: true })
          } catch (err) {
            setSseState('fallback')
            return
          }
          esRef.current = source
          const handle = eventName => event => {
            try {
              const data = event.data ? JSON.parse(event.data) : null
              setLastEvent({ name: eventName, at: new Date().toLocaleTimeString() })
              setSummary(previous => applyEvent(previous, watched, data))
              if (eventName === 'status' && data && TERMINAL.indexOf(data.status) >= 0) {
                setSseState('closed')
                try { source.close() } catch { /* already closed */ }
                esRef.current = null
                void refresh()
              }
            } catch { /* ignore malformed event payloads */ }
          }
          source.addEventListener('progress', handle('progress'))
          source.addEventListener('status', handle('status'))
          source.addEventListener('log', handle('log'))
          source.addEventListener('artifact', handle('artifact'))
          source.onopen = () => { retryRef.current = 0; setSseState('open') }
          source.onerror = () => {
            if (disposed) return
            try { source.close() } catch { /* already closed */ }
            esRef.current = null
            const attempt = retryRef.current + 1
            retryRef.current = attempt
            if (attempt <= 3) {
              setSseState('retrying')
              retryTimer.current = setTimeout(connect, Math.min(8000, 400 * Math.pow(2, attempt)))
            } else {
              setSseState('fallback')
            }
          }
        }
        connect()
        return () => { disposed = true; closeSource() }
      }, [watched, reconnectNonce, refresh])

      React.useEffect(() => {
        if (sseState !== 'fallback') return undefined
        const poll = setInterval(() => { void refresh() }, 2000)
        const probe = setInterval(() => { setReconnectNonce(value => value + 1) }, 15000)
        return () => { clearInterval(poll); clearInterval(probe) }
      }, [sseState, refresh])

      const createPing = React.useCallback(async () => {
        setError(null)
        try {
          const job = await fetchJson(JOBS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'ping', params: {} }) })
          setWatched(job && job.id ? job.id : null)
          setSseState('idle')
          retryRef.current = 0
          await refresh()
          return job
        } catch (err) {
          setError('创建 ping 任务失败：' + String(err && err.message ? err.message : err))
          return null
        }
      }, [refresh])

      return { summary, error, loading, updatedAt, sseState, lastEvent, refresh, createPing }
    }

    function KeyValue(props) {
      return h('div', { style: { display: 'flex', gap: 8, marginBottom: 6, fontSize: 13 } },
        h('span', { style: { color: COLORS.muted, minWidth: 150 } }, props.label),
        h('span', { style: { color: props.color || COLORS.text } }, props.value))
    }

    function AmsHomePage() {
      const consoleState = useAmsConsole()
      const summary = consoleState.summary
      const gateway = summary && summary.gateway ? summary.gateway : null
      const tools = summary && Array.isArray(summary.tools) ? summary.tools : []
      const jobs = summary && Array.isArray(summary.jobs) ? summary.jobs : []
      const gatewayOk = Boolean(gateway && gateway.ok)

      return h('div', { style: { height: '100%', overflow: 'auto', padding: 24, background: COLORS.bg, color: COLORS.text } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 } },
          h('h1', { style: { margin: 0, fontSize: 22 } }, 'AMS 音乐工作站'),
          h('span', { style: { color: COLORS.muted, fontSize: 13 } }, 'M1 加固版 · 插件 @ams/plugin-ui v' + (summary ? String(summary.pluginVersion) : '…'))),
        h('p', { style: { color: COLORS.muted, fontSize: 13, marginTop: 0 } },
          '数据经 Host 插件 @ams/plugin-core 鉴权桥接；任务进度走 SSE 透传（EventSource），断线自动重连/降级轮询。',
          consoleState.updatedAt ? ' · 最近刷新 ' + consoleState.updatedAt : ''),

        consoleState.error ? h('div', { style: cardStyle({ borderColor: COLORS.err, color: COLORS.err }) },
          '请求失败：' + consoleState.error,
          h('div', { style: { color: COLORS.muted, fontSize: 12, marginTop: 6 } }, '请确认 Gateway 已启动；若为 401，页面会自动重新申请同源 session。')) : null,

        h('div', { style: cardStyle() },
          h('h2', { style: { margin: '0 0 12px', fontSize: 16 } }, '运行状态'),
          h(KeyValue, { label: 'Host 插件', value: summary ? summary.plugin + ' v' + summary.pluginVersion : '等待 /ams/api/summary …' }),
          h(KeyValue, { label: '页面鉴权', value: summary && summary.auth ? summary.auth + '（Bearer token 不出 Host）' : '未知' }),
          h(KeyValue, { label: 'SSE 状态', value: sseLabel(consoleState.sseState), color: sseColor(consoleState.sseState) }),
          h(KeyValue, { label: '最近事件', value: consoleState.lastEvent ? consoleState.lastEvent.name + ' @ ' + consoleState.lastEvent.at : '暂无' }),
          h(KeyValue, { label: 'Gateway', value: gateway ? (gatewayOk ? 'ok' : 'down') + ' · ' + String(gateway.base || '') : '未知', color: gatewayOk ? COLORS.ok : COLORS.err }),
          h(KeyValue, { label: 'Gateway 版本', value: gateway && gateway.version ? String(gateway.version) : 'n/a' }),
          h(KeyValue, { label: '已注册工具', value: tools.length > 0 ? tools.join(', ') : '（等待 Host 插件）' })),

        h('div', { style: cardStyle() },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 } },
            h('h2', { style: { margin: 0, fontSize: 16 } }, '任务（Gateway Job）'),
            h('button', {
              style: { background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: gatewayOk ? 'pointer' : 'not-allowed', fontSize: 13 },
              disabled: !gatewayOk,
              onClick: () => { void consoleState.createPing() }
            }, '创建 ping 任务'),
            consoleState.sseState === 'fallback' ? h('span', { style: { color: COLORS.warn, fontSize: 12 } }, 'SSE 不可用，轮询中') : null),
          jobs.length === 0
            ? h('div', { style: { color: COLORS.muted, fontSize: 13 } }, '暂无任务。点击上方按钮，或让 Agent 调用 music_job_submit 工具创建。')
            : h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 } },
              h('thead', null,
                h('tr', null,
                  h('th', { style: { textAlign: 'left', padding: '6px 8px', color: COLORS.muted, borderBottom: '1px solid ' + COLORS.border } }, 'Job ID'),
                  h('th', { style: { textAlign: 'left', padding: '6px 8px', color: COLORS.muted, borderBottom: '1px solid ' + COLORS.border } }, '类型'),
                  h('th', { style: { textAlign: 'left', padding: '6px 8px', color: COLORS.muted, borderBottom: '1px solid ' + COLORS.border } }, '状态'),
                  h('th', { style: { textAlign: 'left', padding: '6px 8px', color: COLORS.muted, borderBottom: '1px solid ' + COLORS.border } }, '进度'),
                  h('th', { style: { textAlign: 'left', padding: '6px 8px', color: COLORS.muted, borderBottom: '1px solid ' + COLORS.border } }, '阶段'))),
              h('tbody', null, jobs.map(job => h('tr', { key: String(job.id), style: job.id === watched ? { background: 'rgba(91,141,239,0.10)' } : undefined },
                h('td', { style: { padding: '6px 8px', fontFamily: 'monospace' } }, String(job.id)),
                h('td', { style: { padding: '6px 8px' } }, String(job.type)),
                h('td', { style: { padding: '6px 8px', color: statusColor(job.status) } }, String(job.status)),
                h('td', { style: { padding: '6px 8px' } }, typeof job.progress === 'number' ? String(Math.round(job.progress)) + '%' : '-'),
                h('td', { style: { padding: '6px 8px', color: COLORS.muted } }, job.stage ? String(job.stage) : '-')))))),

        h('div', { style: { color: COLORS.muted, fontSize: 12 } },
          '安全模型：浏览器只持有 30 分钟同源 HttpOnly session cookie；所有 /ams/api/* 均校验 Bearer token 或 session。M1 限制：SSE 透传未做逐事件背压；session 存于 Host 进程内存，重启即失效。'))
    }

    function AmsPanelIcon() {
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 18, height: 18, borderRadius: 4, background: 'rgba(91,141,239,0.18)', color: COLORS.accent,
          fontSize: 12, fontWeight: 700
        },
        'aria-hidden': 'true'
      }, '♪')
    }

    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, AmsHomePage))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 10,
        label: () => 'AMS 音乐'
      }, AmsPanelIcon))
      console.log('[ams-plugin-ui] registered page ' + PANEL_ID + ' and sidebar entry')
    }

    exports.name = 'ams-plugin-ui'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
