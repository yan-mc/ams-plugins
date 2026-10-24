/**
 * AMS plugin-ui (Client): lazy-CJS bundle loaded by the DSH client module system.
 *
 * M1 feature pages (task-26):
 * - Tabbed workspace: 音源炼制 / 人声分离 / 变声器 / 歌曲换源 / TTS 占位.
 * - Each feature tab builds a Gateway job (train.rvc / separate.pymss /
 *   convert.rvc / convert.msvc) from a small form; the task list supports
 *   cancel and live progress through authenticated SSE.
 * - Keeps the M1 hardening: same-origin session bootstrap, EventSource with
 *   reconnect + fallback polling, all bridge routes authenticated.
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
    const CANCELLABLE = ['queued', 'running']

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

    const FEATURE_TABS = [
      {
        id: 'train', label: '音源炼制', jobType: 'train.rvc',
        note: '训练音色模型（RVC 管线）。参数按协议透传给 Gateway；若当前 Gateway 未注册 train.rvc，提交会在页面显示错误原因。',
        submitLabel: '开始炼制',
        fields: [
          { key: 'dataset_dir', label: '训练数据集目录', placeholder: 'F:/AMS/dataset/我的音色', importable: true },
          { key: 'model', label: '模型名', placeholder: '我的音色' },
          { key: 'epochs', label: 'Epochs', kind: 'number', initial: '100' },
          { key: 'batch_size', label: 'Batch size', kind: 'number', initial: '8' },
          { key: 'sample_rate', label: '采样率', kind: 'number', initial: '40000' }
        ]
      },
      {
        id: 'separate', label: '人声分离', jobType: 'separate.pymss',
        note: 'pymss 人声/伴奏分离（GPU 串行队列）。输入整曲，输出 vocals/drums/bass/other stems。',
        submitLabel: '开始分离',
        fields: [
          { key: 'input_path', label: '输入音频', placeholder: '选择或导入整曲音频', required: true, importable: true },
          { key: 'model', label: '分离模型', kind: 'select', initial: 'scnet_checkpoint_musdb18', required: true, options: ['scnet_checkpoint_musdb18', 'bs_roformer_voc_hyperacev2'] },
          { key: 'device', label: '设备', kind: 'select', options: ['auto', 'cuda:0', 'cpu'], initial: 'auto' }
        ]
      },
      {
        id: 'convert', label: '歌曲换源', jobType: 'convert.rvc',
        folder: { kind: 'rvc_voices', label: '打开变声音源目录', path: 'data/voices' },
        note: '输入已分离好的纯人声，输出目标音色的纯人声。不混伴奏，不使用 MSVC。',
        submitLabel: '开始换源',
        fields: [
          { key: 'input_path', label: '纯人声输入', placeholder: '选择或导入已分离的人声文件', required: true, importable: true },
          { key: 'voice_name', label: '目标音色', kind: 'select', optionsKey: 'voices', placeholder: '请选择目标音色', required: true },
          { key: 'f0_up_key', label: '变调（半音）', kind: 'number', initial: '0' },
          { key: 'index_rate', label: '索引混合率（0-1）', kind: 'number', initial: '0.75' },
          { key: 'device', label: '设备', kind: 'select', options: ['cuda:0', 'cuda', 'cpu'], initial: 'cuda:0' }
        ]
      },
      {
        id: 'tts', label: 'TTS 语音合成', jobType: 'tts.synthesize',
        folder: { kind: 'tts_voices', label: '打开 TTS 音源目录', path: 'data/tts_voices' },
        note: 'Piper 离线 TTS：文本提交给 Gateway，产物写入 data/artifacts。TTS 音源与变声音源分开，可放入 data/tts_voices。',
        submitLabel: '开始合成',
        fields: [
          { key: 'text', label: '要合成的文本', kind: 'textarea', required: true, placeholder: '输入文本（最多 2000 字）' },
          { key: 'model', label: 'TTS 模型', kind: 'select', optionsKey: 'ttsModels', placeholder: '留空使用默认模型' }
        ]
      }
    ]

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

    function initialForm(tab) {
      const form = {}
      for (const field of tab.fields) form[field.key] = field.initial !== undefined ? field.initial : ''
      return form
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
        const message = body && body.error && body.error.message ? String(body.error.message) : ('HTTP ' + String(response.status))
        const error = new Error(message)
        error.status = response.status
        error.body = body
        throw error
      }
      return body
    }

    async function ensureSession() {
      const response = await fetch(SESSION_PATH, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
      const text = await response.text()
      if (!response.ok) throw new Error('session bootstrap HTTP ' + String(response.status) + ' ' + text.slice(0, 160))
      return JSON.parse(text || '{}')
    }

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

      const submitJob = React.useCallback(async (type, params) => {
        setError(null)
        try {
          const job = await fetchJson(JOBS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, params }) })
          if (job && job.id) setWatched(job.id)
          setSseState('idle')
          retryRef.current = 0
          await refresh()
          return { ok: true, job }
        } catch (err) {
          return { ok: false, message: String(err && err.message ? err.message : err) }
        }
      }, [refresh])

      const cancelJob = React.useCallback(async (jobId) => {
        try {
          await fetchJson(JOBS_PATH + '/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST' })
          await refresh()
          return { ok: true }
        } catch (err) {
          return { ok: false, message: String(err && err.message ? err.message : err) }
        }
      }, [refresh])

      return { summary, error, loading, updatedAt, sseState, lastEvent, refresh, submitJob, cancelJob }
    }

    function KeyValue(props) {
      return h('div', { style: { display: 'flex', gap: 8, marginBottom: 6, fontSize: 13 } },
        h('span', { style: { color: COLORS.muted, minWidth: 150 } }, props.label),
        h('span', { style: { color: props.color || COLORS.text } }, props.value))
    }

    function fieldInputStyle() {
      return { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid ' + COLORS.border, background: COLORS.bg, color: COLORS.text, fontSize: 13 }
    }

    function FormField(props) {
      const field = props.field
      const value = props.value
      const onChange = props.onChange
      const onImport = props.onImport
      const onPickFile = props.onPickFile
      const common = { style: fieldInputStyle(), value: value, onChange: event => onChange(field.key, event.target.value) }
      const control = field.kind === 'select'
        ? h('select', common,
            h('option', { key: '__empty', value: '' }, field.placeholder || '请选择…'),
            (field.options || []).map(option => typeof option === 'string' ? h('option', { key: option, value: option }, option) : h('option', { key: option.value, value: option.value }, option.label)))
        : field.kind === 'textarea'
          ? h('textarea', Object.assign({ rows: 5, placeholder: field.placeholder || '' }, common))
          : h('input', Object.assign({ type: field.kind === 'number' ? 'number' : 'text', placeholder: field.placeholder || '' }, common))
      return h('label', { style: { display: 'block', marginBottom: 10 } },
        h('span', { style: { display: 'block', color: COLORS.muted, fontSize: 12, marginBottom: 4 } }, field.label + (field.required ? ' *' : '')),
        control,
        field.importable
          ? h('span', { style: { display: 'inline-flex', gap: 6, marginTop: 5, flexWrap: 'wrap' } },
              h('button', { type: 'button', onClick: () => { void onPickFile(field.key) }, style: { background: COLORS.accent, color: '#fff', border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '3px 9px', fontSize: 12, cursor: 'pointer' } }, '选择文件'),
              h('button', { type: 'button', disabled: !value, onClick: () => { void onImport(field.key, value) }, style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '3px 9px', fontSize: 12, cursor: value ? 'pointer' : 'not-allowed' } }, '导入到 data'))
          : null)
    }

    function FeatureTab(props) {
      const tab = props.tab
      const form = props.form
      const summary = props.summary
      const message = props.message
      const busy = props.busy
      const onChange = props.onChange
      const onSubmit = props.onSubmit
      const onImport = props.onImport
      const onOpenFolder = props.onOpenFolder
      const onPickFile = props.onPickFile
      const dynamicOptions = props.dynamicOptions || {}
      const fields = tab.fields.map(field => field.optionsKey ? Object.assign({}, field, { options: dynamicOptions[field.optionsKey] || [] }) : field)
      const registered = new Set((summary && Array.isArray(summary.jobTypes) ? summary.jobTypes : []).map(item => item.type))
      const available = tab.jobType !== null && registered.has(tab.jobType)
      return h('div', null,
        tab.note ? h('div', { style: { color: available ? COLORS.muted : COLORS.warn, fontSize: 12, marginBottom: 12, lineHeight: 1.6 } }, tab.note) : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0 16px' } },
          fields.map(field => h(FormField, { key: field.key, field: field, value: form[field.key], onChange: onChange, onImport: onImport, onPickFile: onPickFile }))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 } },
          h('button', {
            style: {
              background: tab.jobType === null ? COLORS.muted : COLORS.accent,
              color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 13,
              cursor: tab.jobType === null || busy ? 'not-allowed' : 'pointer'
            },
            disabled: tab.jobType === null || busy,
            onClick: onSubmit
          }, busy ? '提交中…' : tab.submitLabel),
          tab.folder ? h('button', {
            type: 'button',
            onClick: () => { void onOpenFolder(tab.folder.kind) },
            style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }
          }, tab.folder.label) : null,
          tab.folder ? h('span', { style: { color: COLORS.muted, fontSize: 11 } }, '路径：' + tab.folder.path) : null,
          tab.jobType !== null && !available
            ? h('span', { style: { color: COLORS.warn, fontSize: 12 } }, 'Gateway 当前未注册 ' + tab.jobType + '（可用：' + (summary && Array.isArray(summary.jobTypes) ? summary.jobTypes.map(item => item.type).join(', ') : '未知') + '）')
            : null,
          message ? h('span', { style: { color: message.ok ? COLORS.ok : COLORS.err, fontSize: 12 } }, message.text) : null))
    }

    function AmsHomePage() {
      const consoleState = useAmsConsole()
      const [activeTab, setActiveTab] = React.useState('convert')
      const [forms, setForms] = React.useState(() => {
        const value = {}
        for (const tab of FEATURE_TABS) value[tab.id] = initialForm(tab)
        return value
      })
      const [busyTab, setBusyTab] = React.useState(null)
      const [messages, setMessages] = React.useState({})
      const [voices, setVoices] = React.useState([])
      const [ttsModels, setTtsModels] = React.useState([])
      const [cancelBusy, setCancelBusy] = React.useState(null)
      const [connection, setConnection] = React.useState(null)
      const [connBase, setConnBase] = React.useState('')
      const [connKey, setConnKey] = React.useState('')
      const [connBusy, setConnBusy] = React.useState(false)
      const [connMessage, setConnMessage] = React.useState('')

      const refreshConnection = React.useCallback(async () => {
        try {
          const value = await fetchJson('/ams/api/connection')
          setConnection(value)
          if (!connBase && value && value.base_url) setConnBase(value.base_url)
        } catch (error) { setConnMessage('读取连接配置失败：' + String(error && error.message ? error.message : error)) }
      }, [connBase])

      React.useEffect(() => { void refreshConnection() }, [])

      React.useEffect(() => {
        void (async () => {
          try {
            const value = await fetchJson('/ams/api/voices')
            const list = value && value.data && Array.isArray(value.data.voices) ? value.data.voices : []
            setVoices(list.map(voice => ({ label: voice.name, value: voice.pth && voice.pth.file ? voice.pth.file : voice.name })))
          } catch (error) { /* voices are optional */ }
          try {
            const value = await fetchJson('/ams/api/tts/models')
            const list = value && value.data && Array.isArray(value.data.models) ? value.data.models : []
            setTtsModels(list.map(model => ({ label: model.name, value: model.path })))
          } catch (error) { /* tts models are optional */ }
        })()
      }, [])

      React.useEffect(() => {
        if (voices.length === 0) return
        setForms(previous => {
          if (previous.convert && previous.convert.voice_name) return previous
          return Object.assign({}, previous, { convert: Object.assign({}, previous.convert, { voice_name: voices[0].value }) })
        })
      }, [voices])

      React.useEffect(() => {
        if (ttsModels.length === 0) return
        setForms(previous => {
          if (previous.tts && previous.tts.model) return previous
          return Object.assign({}, previous, { tts: Object.assign({}, previous.tts, { model: ttsModels[0].value }) })
        })
      }, [ttsModels])

      const saveConnection = async () => {
        setConnBusy(true)
        setConnMessage('')
        try {
          const value = await fetchJson('/ams/api/connection', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ base_url: connBase, api_key: connKey })
          })
          setConnection(value)
          setConnKey('')
          setConnMessage('已保存；重启 AMS Kernel 后生效。')
        } catch (error) { setConnMessage('保存失败：' + String(error && error.message ? error.message : error)) }
        finally { setConnBusy(false) }
      }

      const summary = consoleState.summary
      const gateway = summary && summary.gateway ? summary.gateway : null
      const tools = summary && Array.isArray(summary.tools) ? summary.tools : []
      const jobs = summary && Array.isArray(summary.jobs) ? summary.jobs : []
      const gatewayOk = Boolean(gateway && gateway.ok)
      const tab = FEATURE_TABS.find(item => item.id === activeTab) || FEATURE_TABS[0]
      const form = forms[tab.id]

      const onChange = (key, value) => {
        setForms(previous => {
          const next = Object.assign({}, previous)
          next[activeTab] = Object.assign({}, next[activeTab], { [key]: value })
          return next
        })
      }

      const onImport = async (key, value) => {
        const source = String(value || '').trim()
        if (!source) return
        try {
          const result = await fetchJson('/ams/api/projects/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source_path: source })
          })
          const target = result && result.data && result.data.path ? result.data.path : ''
          if (!target) throw new Error('导入返回缺少路径')
          onChange(key, target)
          setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: true, text: '已导入到 ' + target } }))
        } catch (error) {
          setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: false, text: '导入失败：' + String(error && error.message ? error.message : error) } }))
        }
      }

      const onOpenFolder = async kind => {
        try {
          const result = await fetchJson('/ams/api/open-folder', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind })
          })
          setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: true, text: '已请求打开目录：' + (result && result.path ? result.path : kind) } }))
        } catch (error) {
          setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: false, text: '打开目录失败：' + String(error && error.message ? error.message : error) } }))
        }
      }

      const onPickFile = (key) => {
        const tab = FEATURE_TABS.find(item => item.id === activeTab) || FEATURE_TABS[0]
        const field = tab.fields.find(item => item.key === key)
        const accept = (field && field.accept) || '.wav,.flac,.mp3,.m4a,.msvc,.pth,.onnx,.json,.zip'
        const picker = document.createElement('input')
        picker.type = 'file'
        picker.accept = accept
        picker.style.display = 'none'
        document.body.appendChild(picker)
        picker.onchange = async () => {
          const file = picker.files && picker.files[0]
          picker.remove()
          if (!file) return
          setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: true, text: '正在复制文件到 data…' } }))
          try {
            const response = await fetch('/ams/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file })
            const text = await response.text()
            let body = null
            try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
            if (!response.ok) throw new Error(body && body.error && body.error.message ? body.error.message : ('HTTP ' + response.status))
            const target = body && body.data && body.data.path ? body.data.path : ''
            if (!target) throw new Error('上传返回缺少路径')
            onChange(key, target)
            setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: true, text: '已选择并复制到：' + target } }))
          } catch (error) {
            setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: false, text: '选择文件失败：' + String(error && error.message ? error.message : error) } }))
          }
        }
        picker.click()
      }

      const onSubmit = async () => {
        if (tab.jobType === null || busyTab !== null) return
        const missing = tab.fields.find(field => field.required && (form[field.key] === undefined || form[field.key] === null || String(form[field.key]).trim() === ''))
        if (missing) {
          setMessages(previous => Object.assign({}, previous, { [tab.id]: { ok: false, text: '请先填写：' + missing.label } }))
          return
        }
        setBusyTab(tab.id)
        const params = {}
        for (const field of tab.fields) {
          const raw = form[field.key]
          if (raw === undefined || raw === null || String(raw).trim() === '') continue
          params[field.key] = field.kind === 'number' ? Number(raw) : raw
        }
        const result = await consoleState.submitJob(tab.jobType, params)
        setBusyTab(null)
        if (result.ok) {
          setMessages(previous => Object.assign({}, previous, { [tab.id]: { ok: true, text: '已提交任务 ' + result.job.id + '（类型 ' + tab.jobType + '）' } }))
        } else {
          const hint = result.message.indexOf('422') >= 0 || result.message.indexOf('未知任务类型') >= 0
            ? '（Gateway 尚未注册该任务类型；参数已按协议透传，M2 接入 Runner 后即可执行）'
            : ''
          setMessages(previous => Object.assign({}, previous, { [tab.id]: { ok: false, text: '提交失败：' + result.message + hint } }))
        }
      }

      const onCancel = async jobId => {
        setCancelBusy(jobId)
        const result = await consoleState.cancelJob(jobId)
        setCancelBusy(null)
        if (!result.ok) setMessages(previous => Object.assign({}, previous, { jobs: { ok: false, text: '取消失败：' + result.message } }))
        else setMessages(previous => Object.assign({}, previous, { jobs: { ok: true, text: '已请求取消 ' + jobId } }))
      }

      return h('div', { style: { height: '100%', overflow: 'auto', padding: 24, background: COLORS.bg, color: COLORS.text } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 } },
          h('h1', { style: { margin: 0, fontSize: 22 } }, 'AMS 音乐工作站'),
          h('span', { style: { color: COLORS.muted, fontSize: 13 } }, 'M1 功能页 · @ams/plugin-ui v' + (summary ? String(summary.pluginVersion) : '…'))),
        h('p', { style: { color: COLORS.muted, fontSize: 13, marginTop: 0, marginBottom: 16 } },
          '数据经 Host 插件 @ams/plugin-core 鉴权桥接；任务进度走 SSE 透传（EventSource），断线自动重连/降级轮询。',
          consoleState.updatedAt ? ' · 最近刷新 ' + consoleState.updatedAt : ''),

        consoleState.error ? h('div', { style: cardStyle({ borderColor: COLORS.err, color: COLORS.err }) }, '请求失败：' + consoleState.error) : null,

        h('div', { style: cardStyle() },
          h('h2', { style: { margin: '0 0 10px', fontSize: 16 } }, '连接设置'),
          h('p', { style: { color: COLORS.muted, fontSize: 12, marginTop: 0 } }, '只保存网址和 Key；不创建环境变量，配置在 AMS 安装目录内。保存后重启 AMS Kernel 生效。'),
          h('label', { style: { display: 'block', marginBottom: 8, fontSize: 13 } }, '网址',
            h('input', { value: connBase, onChange: e => setConnBase(e.target.value), placeholder: 'https://api.deepseek.com/anthropic', style: { display: 'block', width: '100%', marginTop: 4, padding: '7px 8px', background: COLORS.bg, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 6 } })),
          h('label', { style: { display: 'block', marginBottom: 8, fontSize: 13 } }, 'Key',
            h('input', { value: connKey, onChange: e => setConnKey(e.target.value), type: 'password', placeholder: connection && connection.has_api_key ? '已保存（留空表示不修改）' : '输入 API Key', style: { display: 'block', width: '100%', marginTop: 4, padding: '7px 8px', background: COLORS.bg, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 6 } })),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { disabled: connBusy, onClick: () => { void saveConnection() }, style: { background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 13, cursor: connBusy ? 'wait' : 'pointer' } }, connBusy ? '保存中…' : '保存连接'),
            h('span', { style: { color: COLORS.muted, fontSize: 12 } }, connection ? (connection.configured ? '已配置' : '未配置') : '读取中…')),
          connMessage ? h('div', { style: { color: connMessage.indexOf('失败') >= 0 ? COLORS.err : COLORS.ok, fontSize: 12, marginTop: 8 } }, connMessage) : null),

        h('div', { style: cardStyle() },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 } },
            FEATURE_TABS.map(item => h('button', {
              key: item.id,
              style: {
                background: item.id === activeTab ? COLORS.accent : 'transparent',
                color: item.id === activeTab ? '#fff' : COLORS.text,
                border: '1px solid ' + (item.id === activeTab ? COLORS.accent : COLORS.border),
                borderRadius: 6, padding: '6px 14px', fontSize: 13, cursor: 'pointer'
              },
              onClick: () => setActiveTab(item.id)
            }, item.label))),
          h(FeatureTab, {
            tab: tab, form: form, summary: summary, message: messages[tab.id],
            busy: busyTab === tab.id, onChange: onChange, onSubmit: onSubmit, onImport: onImport, onOpenFolder: onOpenFolder, onPickFile: onPickFile, dynamicOptions: { voices: voices, ttsModels: ttsModels }
          })),

        h('div', { style: cardStyle() },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10, flexWrap: 'wrap' } },
            h('h2', { style: { margin: 0, fontSize: 16 } }, '任务（Gateway Job）'),
            h('span', { style: { color: COLORS.muted, fontSize: 12 } }, '鉴权：' + (summary && summary.auth ? summary.auth : '未知') + ' · SSE：' + sseLabel(consoleState.sseState)),
            h('span', { style: { color: sseColor(consoleState.sseState), fontSize: 12 } }, consoleState.lastEvent ? '最近事件 ' + consoleState.lastEvent.name + ' @ ' + consoleState.lastEvent.at : ''),
            h('button', {
              style: { background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 13, cursor: gatewayOk ? 'pointer' : 'not-allowed' },
              disabled: !gatewayOk,
              onClick: async () => {
                const result = await consoleState.submitJob('ping', {})
                setMessages(previous => Object.assign({}, previous, { jobs: result.ok ? { ok: true, text: '已提交 ping 自检任务 ' + result.job.id } : { ok: false, text: 'ping 提交失败：' + result.message } }))
              }
            }, 'ping 自检'),
            h('button', {
              style: { background: 'transparent', color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 6, padding: '6px 14px', fontSize: 13, cursor: 'pointer' },
              onClick: () => { void consoleState.refresh() }
            }, '刷新列表'),
            h('button', {
              style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 6, padding: '6px 14px', fontSize: 13, cursor: 'pointer' },
              onClick: () => { void onOpenFolder('artifacts') }
            }, '打开产物目录'),
            h('span', { style: { color: COLORS.muted, fontSize: 11 } }, '产物路径：data/artifacts/{job_id}')),
          messages.jobs ? h('div', { style: { color: messages.jobs.ok ? COLORS.ok : COLORS.err, fontSize: 12, marginBottom: 8 } }, messages.jobs.text) : null,
          jobs.length === 0
            ? h('div', { style: { color: COLORS.muted, fontSize: 13 } }, '暂无任务。选择上方功能页提交，或在页面右上角点 ping 自检。')
            : h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 } },
              h('thead', null,
                h('tr', null,
                  ['Job ID', '类型', '状态', '进度', '阶段', '操作'].map(label => h('th', { key: label, style: { textAlign: 'left', padding: '6px 8px', color: COLORS.muted, borderBottom: '1px solid ' + COLORS.border } }, label)))),
              h('tbody', null, jobs.map(job => h('tr', { key: String(job.id) },
                h('td', { style: { padding: '6px 8px', fontFamily: 'monospace' } }, String(job.id)),
                h('td', { style: { padding: '6px 8px' } }, String(job.type)),
                h('td', { style: { padding: '6px 8px', color: statusColor(job.status) } }, String(job.status)),
                h('td', { style: { padding: '6px 8px' } }, typeof job.progress === 'number' ? String(Math.round(job.progress)) + '%' : '-'),
                h('td', { style: { padding: '6px 8px', color: COLORS.muted } }, job.stage ? String(job.stage) : '-'),
                h('td', { style: { padding: '6px 8px' } },
                  CANCELLABLE.indexOf(job.status) >= 0
                    ? h('button', {
                        style: { background: 'transparent', color: COLORS.err, border: '1px solid ' + COLORS.err, borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: cancelBusy === job.id ? 'wait' : 'pointer' },
                        disabled: cancelBusy === job.id,
                        onClick: () => { void onCancel(job.id) }
                      }, cancelBusy === job.id ? '取消中…' : '取消')
                    : h('span', { style: { color: COLORS.muted } }, '-'))))))),

        h('div', { style: cardStyle() },
          h('h2', { style: { margin: '0 0 10px', fontSize: 16 } }, '运行状态'),
          h(KeyValue, { label: 'Host 插件', value: summary ? summary.plugin + ' v' + summary.pluginVersion : '等待 /ams/api/summary …' }),
          h(KeyValue, { label: '已注册工具', value: tools.length > 0 ? tools.join(', ') : '（等待 Host 插件）' }),
          h(KeyValue, { label: 'Gateway', value: gateway ? (gatewayOk ? 'ok' : 'down') + ' · ' + String(gateway.base || '') : '未知', color: gatewayOk ? COLORS.ok : COLORS.err }),
          h(KeyValue, { label: 'Gateway 任务类型', value: summary && Array.isArray(summary.jobTypes) && summary.jobTypes.length > 0 ? summary.jobTypes.map(item => item.type + (item.gpu ? '(GPU)' : '')).join(', ') : 'n/a' }),
          h(KeyValue, { label: '页面鉴权', value: summary && summary.auth ? summary.auth + '（Gateway token 不出 Host）' : '未知' })),

        h('div', { style: { color: COLORS.muted, fontSize: 12 } },
          'M1 限制：业务 Runner 的可用性取决于当前 Gateway 版本；页面按 /ams/api/summary.jobTypes 提示注册状态，未注册类型提交会返回错误并在页面提示。'))
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
