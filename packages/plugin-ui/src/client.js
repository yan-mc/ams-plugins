/**
 * AMS plugin-ui (Client): lazy-CJS bundle loaded by the DSH client module system.
 *
 * Registers:
 * - main keyed slot page 'ams.home': Gateway health, tool list, recent jobs, create-ping button, 1s polling.
 * - sidebar.panellist entry 'ams.home': icon + label that switches to the page via the sidebar shell.
 */
window.__ModuleLoader__.load({
  id: '@ams/plugin-ui',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'ams.home'
    const REFRESH_MS = 1000

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

    /** Poll /ams/api/summary once per second while the page is mounted. */
    function useAmsSummary() {
      const [state, setState] = React.useState({ loading: true, summary: null, error: null, updatedAt: null })
      React.useEffect(() => {
        let alive = true
        const tick = () => {
          fetch('/ams/api/summary', { headers: { accept: 'application/json' } })
            .then(response => response.ok ? response.json() : Promise.reject(new Error('HTTP ' + String(response.status))))
            .then(data => { if (alive) setState({ loading: false, summary: data, error: null, updatedAt: new Date().toLocaleTimeString() }) })
            .catch(error => { if (alive) setState(previous => ({ loading: false, summary: previous.summary, error: String(error && error.message ? error.message : error), updatedAt: previous.updatedAt })) })
        }
        tick()
        const timer = setInterval(tick, REFRESH_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      return state
    }

    /** Submit a ping job through the Host bridge route. */
    async function submitPingJob() {
      const response = await fetch('/ams/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'ping', params: {} })
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      return response.json()
    }

    function KeyValue(props) {
      return h('div', { style: { display: 'flex', gap: 8, marginBottom: 6, fontSize: 13 } },
        h('span', { style: { color: COLORS.muted, minWidth: 130 } }, props.label),
        h('span', { style: { color: props.color || COLORS.text } }, props.value))
    }

    function AmsHomePage() {
      const state = useAmsSummary()
      const [actionError, setActionError] = React.useState(null)
      const [submitting, setSubmitting] = React.useState(false)
      const summary = state.summary
      const gateway = summary && summary.gateway ? summary.gateway : null
      const tools = summary && Array.isArray(summary.tools) ? summary.tools : []
      const jobs = summary && Array.isArray(summary.jobs) ? summary.jobs : []
      const gatewayOk = Boolean(gateway && gateway.ok)

      const onClickPing = () => {
        setSubmitting(true)
        setActionError(null)
        submitPingJob()
          .then(() => { setSubmitting(false) })
          .catch(error => { setSubmitting(false); setActionError(String(error && error.message ? error.message : error)) })
      }

      return h('div', { style: { height: '100%', overflow: 'auto', padding: 24, background: COLORS.bg, color: COLORS.text } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 } },
          h('h1', { style: { margin: 0, fontSize: 22 } }, 'AMS 音乐工作站'),
          h('span', { style: { color: COLORS.muted, fontSize: 13 } }, 'M0.6 最小闭环 · 插件 @ams/plugin-ui')),
        h('p', { style: { color: COLORS.muted, fontSize: 13, marginTop: 0 } },
          '页面数据来自 Host 插件 @ams/plugin-core 的本地桥接路由 /ams/api/*，任务由 ams-gateway 执行。',
          state.updatedAt ? ' · 最近刷新 ' + state.updatedAt : ''),

        state.error ? h('div', { style: cardStyle({ borderColor: COLORS.err, color: COLORS.err }) },
          '插件桥接请求失败：' + state.error,
          h('div', { style: { color: COLORS.muted, fontSize: 12, marginTop: 6 } }, '请确认 Host 插件已加载、AMS Gateway 已启动。')) : null,

        h('div', { style: cardStyle() },
          h('h2', { style: { margin: '0 0 12px', fontSize: 16 } }, '运行状态'),
          h(KeyValue, { label: 'Host 插件', value: summary ? summary.plugin + ' v' + summary.pluginVersion : '等待 /ams/api/summary …' }),
          h(KeyValue, { label: 'Gateway', value: gateway ? (gatewayOk ? 'ok' : 'down') + ' · ' + String(gateway.base || '') : '未知', color: gatewayOk ? COLORS.ok : COLORS.err }),
          h(KeyValue, { label: 'Gateway 版本', value: gateway && gateway.version ? String(gateway.version) : 'n/a' }),
          h(KeyValue, { label: '已注册工具', value: tools.length > 0 ? tools.join(', ') : '（等待 Host 插件）' })),

        h('div', { style: cardStyle() },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 } },
            h('h2', { style: { margin: 0, fontSize: 16 } }, '任务（Gateway Job）'),
            h('button', {
              style: { background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: submitting ? 'wait' : 'pointer', fontSize: 13 },
              disabled: submitting || !gatewayOk,
              onClick: onClickPing
            }, submitting ? '提交中…' : '创建 ping 任务')),
          actionError ? h('div', { style: { color: COLORS.err, fontSize: 13, marginBottom: 8 } }, '创建任务失败：' + actionError) : null,
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
              h('tbody', null, jobs.map(job => h('tr', { key: String(job.id) },
                h('td', { style: { padding: '6px 8px', fontFamily: 'monospace' } }, String(job.id)),
                h('td', { style: { padding: '6px 8px' } }, String(job.type)),
                h('td', { style: { padding: '6px 8px', color: statusColor(job.status) } }, String(job.status)),
                h('td', { style: { padding: '6px 8px' } }, typeof job.progress === 'number' ? String(Math.round(job.progress)) + '%' : '-'),
                h('td', { style: { padding: '6px 8px', color: COLORS.muted } }, job.stage ? String(job.stage) : '-')))))),

        h('div', { style: { color: COLORS.muted, fontSize: 12 } },
          'M0.6 限制：桥接路由未鉴权（仅 loopback）；任务列表取最近 20 条；UI 每 1s 轮询。'))
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
