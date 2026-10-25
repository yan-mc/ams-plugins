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
        note: '训练音色模型（RVC 管线）。默认 v2/48k；40k 仅 v1。显存不足时把 batch 降到 1–2；当前不会自动回退。',
        submitLabel: '开始炼制',
        fields: [
          { key: 'dataset_dir', label: '训练数据集目录', placeholder: 'data/datasets/<名称>/sources 或 processed', importable: true },
          { key: 'model_name', label: '模型名', placeholder: '我的音色' },
          { key: 'version', label: '模型版本', kind: 'select', options: ['v2', 'v1'], initial: 'v2' },
          { key: 'sample_rate', label: '采样率', kind: 'select', options: ['48k', '32k', '40k'], initial: '48k' },
          { key: 'if_f0', label: 'F0 引导', kind: 'select', options: ['1', '0'], initial: '1' },
          { key: 'f0_method', label: 'F0 提取方法', kind: 'select', options: ['rmvpe', 'harvest', 'pm'], initial: 'rmvpe' },
          { key: 'epochs', label: 'Epochs', kind: 'number', initial: '100' },
          { key: 'batch_size', label: 'Batch size', kind: 'number', initial: '4' },
          { key: 'save_every', label: '每 N epoch 保存', kind: 'number', initial: '10' },
          { key: 'gpu', label: 'GPU', kind: 'text', initial: '0' }
        ]
      },
      {
        id: 'dataset', label: '数据集工作室', jobType: 'dataset.prepare',
        note: '导入 wav 或目录，统一 48k 单声道并切成 3–10 秒片段；产物在 data/datasets/<名称>/processed。',
        submitLabel: '准备数据集',
        fields: [
          { key: 'source_path', label: '源音频/目录', required: true, importable: true },
          { key: 'dataset_name', label: '数据集名称', placeholder: '我的音色数据集' },
          { key: 'target_sr', label: '目标采样率', kind: 'select', options: ['48000', '40000', '32000'], initial: '48000' },
          { key: 'min_sec', label: '最短片段（秒）', kind: 'number', initial: '3' },
          { key: 'max_sec', label: '最长片段（秒）', kind: 'number', initial: '10' }
        ]
      },
      {
        id: 'evaluate', label: '评测器', jobType: 'evaluate.audio',
        note: '客观指标：时长/采样率/声道/削波/静音/RMS；可选参考音频计算 SNR。', submitLabel: '开始评测',
        fields: [
          { key: 'input_path', label: '待评测音频', required: true, importable: true },
          { key: 'reference_path', label: '参考音频（可选）', importable: true }
        ]
      },
      {
        id: 'mix', label: '混音母带', jobType: 'mix.master',
        note: '独立工具，不进入歌曲换源。多轨输入用分号或换行分隔；输出响度归一 + 限幅。', submitLabel: '开始混音',
        fields: [
          { key: 'input_paths', label: '输入轨道（分号/换行）', required: true, placeholder: 'a.wav;b.wav' },
          { key: 'track_gains', label: '逐轨增益 dB（逗号分隔）', kind: 'text', placeholder: '0,-3' },
          { key: 'track_pans', label: '逐轨声像 -1..1（逗号分隔）', kind: 'text', placeholder: '0,0' },
          { key: 'eq_low', label: '逐轨低频 EQ dB（100Hz）', kind: 'text', placeholder: '0,0' },
          { key: 'eq_mid', label: '逐轨中频 EQ dB（1kHz）', kind: 'text', placeholder: '0,0' },
          { key: 'eq_high', label: '逐轨高频 EQ dB（8kHz）', kind: 'text', placeholder: '0,0' },
          { key: 'loudness', label: '目标 LUFS', kind: 'text', initial: '-14' },
          { key: 'true_peak', label: '真峰值 dBTP', kind: 'text', initial: '-1' }
        ]
      },
      {
        id: 'separate', label: '人声分离', jobType: 'separate.pymss',
        note: 'pymss 人声/伴奏分离（GPU 串行队列）。输入整曲，输出 vocals/drums/bass/other stems。',
        submitLabel: '开始分离',
        fields: [
          { key: 'input_path', label: '输入音频', placeholder: '选择或导入整曲音频', required: true, importable: true },
          { key: 'model', label: '分离模型', kind: 'select', initial: 'scnet_checkpoint_musdb18', required: true, options: ['scnet_checkpoint_musdb18', 'bs_roformer_voc_hyperacev2'] },
          { key: 'device', label: '设备', kind: 'select', options: ['auto', 'cuda:0', 'cpu'], initial: 'auto' },
          { key: 'chunk', label: 'chunk 采样点（可选）', kind: 'number', placeholder: '留空使用模型默认' },
          { key: 'overlap_size', label: 'overlap_size（可选）', kind: 'number', placeholder: '留空使用模型默认' },
          { key: 'stem_batch_size', label: 'stem_batch_size（可选）', kind: 'number', placeholder: '留空使用模型默认' },
          { key: 'normalize', label: '输出归一化', kind: 'select', options: ['auto', 'true', 'false'], initial: 'auto' },
          { key: 'standardize', label: '输入标准化', kind: 'select', options: ['auto', 'true', 'false'], initial: 'auto' },
          { key: 'stems', label: '输出 stems（逗号分隔）', placeholder: 'vocals,drums,bass,other；留空为模型全部' }
        ]
      },
      {
        id: 'convert', label: '歌曲换源', jobType: 'convert.rvc',
        folder: { kind: 'rvc_voices', label: '打开变声音源目录', path: 'data/voices' },
        note: '输入已分离好的纯人声，输出目标音色的纯人声。不混伴奏，不使用 MSVC。',
        submitLabel: '开始换源',
        fields: [
          { key: 'input_path', label: '纯人声输入', placeholder: '选择或导入已分离的人声文件', required: true, importable: true },
          { key: 'batch_paths', label: '批量输入（可选，每行一个路径）', placeholder: '留空则只换源上面的单文件' },
          { key: 'voice_name', label: '目标音色', kind: 'select', optionsKey: 'voices', placeholder: '请选择目标音色', required: true },
          { key: 'f0_up_key', label: '变调（半音）', kind: 'number', initial: '0' },
          { key: 'f0_method', label: 'F0 方法', kind: 'select', options: ['rmvpe', 'pm', 'harvest', 'crepe'], initial: 'rmvpe' },
          { key: 'index_rate', label: '索引混合率（0-1）', kind: 'number', initial: '0.75' },
          { key: 'index_path', label: '指定 index（可选，留空自动同名）', placeholder: 'data/voices/<名称>/<名称>.index', importable: true, accept: '.index' },
          { key: 'filter_radius', label: 'filter_radius（0-7）', kind: 'number', initial: '3' },
          { key: 'resample_sr', label: 'resample_sr（0=模型原始）', kind: 'number', initial: '0' },
          { key: 'rms_mix_rate', label: 'rms_mix_rate（0-1）', kind: 'number', initial: '0.25' },
          { key: 'protect', label: 'protect（0-0.5）', kind: 'number', initial: '0.33' },
          { key: 'device', label: '设备', kind: 'select', options: ['cuda:0', 'cuda', 'cpu'], initial: 'cuda:0' }
        ]
      },
      {
        id: 'msvc', label: 'MSVC 工具', jobType: 'convert.msvc',
        note: '将 .msvc 容器转换为标准 RVC pth；不生成 index，不进入歌曲换源主链。',
        submitLabel: '开始转换',
        fields: [
          { key: 'input_path', label: '.msvc 输入', required: true, importable: true, accept: '.msvc' },
          { key: 'reference_pth', label: '参考 pth（可选）', importable: true, accept: '.pth' },
          { key: 'out_dir', label: '输出目录（留空用 artifacts）', placeholder: 'data/artifacts' },
          { key: 'name', label: '输出名称（可选）', placeholder: '留空按输入名' }
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

    const VC_TAB = { id: 'realtime', label: '实时变声', jobType: null, fields: [], note: '实时变声：独立 VC 服务，麦克风/系统输出 → RVC → VB-Cable。' }
    const LIBRARY_TAB = { id: 'library', label: '音色库', jobType: null, fields: [], note: '音色库：标签、备注、收藏、index 状态；删除只移动到 data/trash。' }
    const TTS_BATCH_TAB = { id: 'tts_batch', label: 'TTS 批量', jobType: null, fields: [], note: '同一文本批量合成多个 TTS 音色。' }
    const PROJECT_TAB = { id: 'project', label: '项目', jobType: null, fields: [], note: '工程、步骤和产物关联。' }
    const ALL_TABS = [PROJECT_TAB, VC_TAB, LIBRARY_TAB, TTS_BATCH_TAB].concat(FEATURE_TABS)

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
          const job = await fetchJson(JOBS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, params, project_id: (() => { try { return window.localStorage.getItem('ams.currentProject') || null } catch { return null } })() }) })
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
      const templates = props.templates || []
      const onSaveTemplate = props.onSaveTemplate
      const onApplyTemplate = props.onApplyTemplate
      const onDeleteTemplate = props.onDeleteTemplate
      const onImportTemplate = props.onImportTemplate
      const [selectedTemplate, setSelectedTemplate] = React.useState('')
      const dynamicOptions = props.dynamicOptions || {}
      const fields = tab.fields.map(field => field.optionsKey ? Object.assign({}, field, { options: dynamicOptions[field.optionsKey] || [] }) : field)
      const registered = new Set((summary && Array.isArray(summary.jobTypes) ? summary.jobTypes : []).map(item => item.type))
      const available = tab.jobType !== null && registered.has(tab.jobType)
      return h('div', null,
        tab.note ? h('div', { style: { color: available ? COLORS.muted : COLORS.warn, fontSize: 12, marginBottom: 12, lineHeight: 1.6 } }, tab.note) : null,
        tab.jobType ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 } },
          h('span', { style: { color: COLORS.muted, fontSize: 12 } }, '参数模板'),
          h('select', { value: selectedTemplate, onChange: event => setSelectedTemplate(event.target.value), style: { minWidth: 180, padding: '4px 6px', borderRadius: 5, border: '1px solid ' + COLORS.border, background: COLORS.bg, color: COLORS.text } },
            h('option', { value: '' }, '选择模板…'), templates.map(item => h('option', { key: item.kind + ':' + item.name, value: item.name }, item.name))),
          h('button', { type: 'button', style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '3px 8px', fontSize: 12 }, onClick: () => {
            const item = templates.find(entry => entry.name === selectedTemplate)
            if (item) onApplyTemplate(item.params || {})
          } }, '应用'),
          h('button', { type: 'button', style: { background: 'transparent', color: COLORS.muted, border: '1px solid ' + COLORS.border, borderRadius: 5, padding: '3px 8px', fontSize: 12 }, onClick: () => {
            const name = window.prompt('模板名称（1-64 字符）', selectedTemplate || '')
            if (name) onSaveTemplate(name, form)
          } }, '保存当前'),
          h('button', { type: 'button', disabled: !selectedTemplate, style: { background: 'transparent', color: COLORS.err, border: '1px solid ' + COLORS.err, borderRadius: 5, padding: '3px 8px', fontSize: 12 }, onClick: () => {
            if (selectedTemplate && window.confirm('把模板移动到 data/trash？')) onDeleteTemplate(selectedTemplate)
          } }, '删除'),
          h('button', { type: 'button', disabled: !selectedTemplate, style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '3px 8px', fontSize: 12 }, onClick: () => {
            const item = templates.find(entry => entry.name === selectedTemplate)
            if (!item) return
            const blob = new Blob([JSON.stringify({ schema: 'ams.param-template/1', kind: item.kind, name: item.name, params: item.params || {} }, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob); const anchor = document.createElement('a')
            anchor.href = url; anchor.download = item.kind + '-' + item.name + '.json'; anchor.click(); URL.revokeObjectURL(url)
          } }, '导出'),
          h('button', { type: 'button', style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '3px 8px', fontSize: 12 }, onClick: onImportTemplate }, '导入')) : null,
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

    function VcPanel(props) {
      const devices = props.devices
      const status = props.status || {}
      const form = props.form || {}
      const busy = props.busy
      const message = props.message
      const voices = props.voices || []
      const onChange = props.onChange
      const onRefresh = props.onRefresh
      const onStart = props.onStart
      const onStop = props.onStop
      const onSwitch = props.onSwitch
      const inputs = devices && Array.isArray(devices.inputs) ? devices.inputs : []
      const inputChoices = devices && Array.isArray(devices.input_choices) && devices.input_choices.length ? devices.input_choices : inputs
      const outputs = devices && Array.isArray(devices.outputs) ? devices.outputs : []
      const outputChoices = devices && Array.isArray(devices.output_choices) && devices.output_choices.length ? devices.output_choices : outputs
      const virtual = devices && Array.isArray(devices.virtual_outputs) ? devices.virtual_outputs : []
      const loopbacks = devices && Array.isArray(devices.wasapi_loopbacks) ? devices.wasapi_loopbacks : []
      const inputOptions = inputChoices.map(item => ({ value: String(item.index), label: item.display_name || item.name || ("输入 " + item.index) })).concat(loopbacks.map(item => ({ value: item.value, label: "WASAPI Loopback · " + item.name + (item.is_default ? "（默认输出）" : "") })))
      const outputOptions = outputChoices.map(item => ({ value: String(item.index), label: item.display_name || item.name || ("输出 " + item.index) }))
      const monitorOptions = [{ value: "", label: "不监听" }].concat(outputOptions)
      const mixOptions = [{ value: "", label: "不叠加" }].concat(loopbacks.map(item => ({ value: item.value, label: "叠加 · " + item.name })))
      const select = { width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: 6, border: "1px solid " + COLORS.border, background: COLORS.bg, color: COLORS.text, fontSize: 13 }
      return h("div", { style: cardStyle() },
        h("div", { style: { color: COLORS.muted, fontSize: 12, marginBottom: 10, lineHeight: 1.6 } }, "实时变声服务会占用麦克风/系统输出和 VB-Cable。先选输入、输出与音源，再点启动；停止后才释放设备。内置 WASAPI Loopback 可直接捕获系统输出；没有时仍可使用“立体声混音”。"),
        devices ? h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: "0 16px" } },
          h("label", { style: { display: "block", marginBottom: 10 } }, h("span", { style: { display: "block", color: COLORS.muted, fontSize: 12, marginBottom: 4 } }, "输入设备（麦克风 / 系统输出）"), h("select", { style: select, value: form.input_device || "", onChange: e => onChange("input_device", e.target.value) }, inputOptions.map(item => h("option", { key: item.value, value: item.value }, item.label)))),
          h("label", { style: { display: "block", marginBottom: 10 } }, h("span", { style: { display: "block", color: COLORS.muted, fontSize: 12, marginBottom: 4 } }, "叠加系统声音（可选）"), h("select", { style: select, value: form.mix_loopback || "", onChange: e => onChange("mix_loopback", e.target.value) }, mixOptions.map(item => h("option", { key: item.value || "none", value: item.value }, item.label)))),
          h("label", { style: { display: "block", marginBottom: 10 } }, h("span", { style: { display: "block", color: COLORS.muted, fontSize: 12, marginBottom: 4 } }, "输出设备（VB-Cable → OBS/会议）"), h("select", { style: select, value: form.output_device || "", onChange: e => onChange("output_device", e.target.value) }, outputOptions.map(item => h("option", { key: item.value, value: item.value }, item.label)))),
          h("label", { style: { display: "block", marginBottom: 10 } }, h("span", { style: { display: "block", color: COLORS.muted, fontSize: 12, marginBottom: 4 } }, "监听输出（可选，耳机）"), h("select", { style: select, value: form.monitor_device || "", onChange: e => onChange("monitor_device", e.target.value) }, monitorOptions.map(item => h("option", { key: item.value || "none", value: item.value }, item.label)))),
          h("label", { style: { display: "block", marginBottom: 10 } }, h("span", { style: { display: "block", color: COLORS.muted, fontSize: 12, marginBottom: 4 } }, "模式"), h("select", { style: select, value: form.mode || "rvc", onChange: e => onChange("mode", e.target.value) }, h("option", { value: "rvc" }, "RVC 变声"), h("option", { value: "passthrough" }, "直通（设备测试）"))),
          h("label", { style: { display: "block", marginBottom: 10 } }, h("span", { style: { display: "block", color: COLORS.muted, fontSize: 12, marginBottom: 4 } }, "目标音色"), h("select", { style: select, value: form.voice || "", onChange: e => onChange("voice", e.target.value) }, h("option", { value: "" }, "请选择音色…"), voices.map(item => h("option", { key: item.value, value: item.value }, item.label)))),
          h("label", { style: { display: "block", marginBottom: 10 } }, h("span", { style: { display: "block", color: COLORS.muted, fontSize: 12, marginBottom: 4 } }, "变调（半音）"), h("input", { type: "number", style: select, value: form.pitch === undefined ? "0" : form.pitch, onChange: e => onChange("pitch", e.target.value) })),
          h("label", { style: { display: "block", marginBottom: 10 } }, h("span", { style: { display: "block", color: COLORS.muted, fontSize: 12, marginBottom: 4 } }, "索引混合率"), h("input", { type: "number", min: 0, max: 1, step: 0.05, style: select, value: form.index_rate === undefined ? "0" : form.index_rate, onChange: e => onChange("index_rate", e.target.value) })),
          h("label", { style: { display: "block", marginBottom: 10 } }, h("span", { style: { display: "block", color: COLORS.muted, fontSize: 12, marginBottom: 4 } }, "F0 方法"), h("select", { style: select, value: form.f0method || "rmvpe", onChange: e => onChange("f0method", e.target.value) }, ["rmvpe", "pm", "harvest", "crepe"].map(item => h("option", { key: item, value: item }, item)))),
          h("label", { style: { display: "block", marginBottom: 10 } }, h("span", { style: { display: "block", color: COLORS.muted, fontSize: 12, marginBottom: 4 } }, "延迟模式"), h("select", { style: select, value: form.latency_mode || "low", onChange: e => onChange("latency_mode", e.target.value) }, h("option", { value: "ultra" }, "极低延迟（实验：block 50ms / buffer 150ms）"), h("option", { value: "low" }, "低延迟（block 100ms / buffer 250ms）"), h("option", { value: "stable" }, "稳定（block 250ms / buffer 1000ms）"))))
          : h("div", { style: { color: COLORS.warn, fontSize: 12 } }, "正在检测设备…"),
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 } },
          h("button", { type: "button", disabled: busy, onClick: onRefresh, style: { background: "transparent", color: COLORS.accent, border: "1px solid " + COLORS.accent, borderRadius: 5, padding: "5px 10px", fontSize: 12 } }, "刷新设备"),
          h("button", { type: "button", disabled: busy || status.running, onClick: onStart, style: { background: COLORS.accent, color: "#fff", border: "1px solid " + COLORS.accent, borderRadius: 5, padding: "5px 12px", fontSize: 12 } }, status.running ? "运行中" : "启动实时变声"),
          h("button", { type: "button", disabled: busy || !status.running, onClick: onSwitch, style: { background: "transparent", color: COLORS.warn, border: "1px solid " + COLORS.warn, borderRadius: 5, padding: "5px 10px", fontSize: 12 } }, "切换音色"),
          h("button", { type: "button", disabled: busy || !status.running, onClick: onStop, style: { background: "transparent", color: COLORS.err, border: "1px solid " + COLORS.err, borderRadius: 5, padding: "5px 10px", fontSize: 12 } }, "停止")),
        status.running ? h("div", { style: { color: COLORS.ok, fontSize: 12, marginTop: 8 } }, "运行中 · " + (status.mode || "") + " · " + String(status.samplerate || "") + " Hz · frames=" + String(status.frames || 0) + (status.stats ? " · infer=" + String(status.stats.infer_ms) + "ms · p95=" + String(status.stats.infer_p95_ms || 0) + "ms · est=" + String(status.stats.estimated_latency_ms) + "ms" : "") + (status.levels ? " · IN=" + String(status.levels.input) + " OUT=" + String(status.levels.output) : "")) : null,
        status.levels ? h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6 } },
          h("span", { style: { color: COLORS.muted, fontSize: 11, width: 22 } }, "IN"),
          h("div", { style: { flex: 1, height: 6, background: COLORS.border, borderRadius: 3, overflow: "hidden" } }, h("div", { style: { width: Math.min(100, Math.sqrt(Number(status.levels.input || 0)) * 250) + "%", height: "100%", background: COLORS.ok } })),
          h("span", { style: { color: COLORS.muted, fontSize: 11, width: 30 } }, "OUT"),
          h("div", { style: { flex: 1, height: 6, background: COLORS.border, borderRadius: 3, overflow: "hidden" } }, h("div", { style: { width: Math.min(100, Math.sqrt(Number(status.levels.output || 0)) * 250) + "%", height: "100%", background: COLORS.accent } }))
        ) : null,
        status.last_error ? h("div", { style: { color: COLORS.err, fontSize: 12, marginTop: 8 } }, "错误：" + status.last_error) : null,
        message ? h("div", { style: { color: message.ok ? COLORS.ok : COLORS.err, fontSize: 12, marginTop: 8 } }, message.text) : null
      )
    }


    function ProjectPanel(props) {
      const [items, setItems] = React.useState([])
      const [current, setCurrent] = React.useState(() => { try { return window.localStorage.getItem('ams.currentProject') || '' } catch { return '' } })
      const [name, setName] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [jobs, setJobs] = React.useState([])
      const refresh = async () => {
        try {
          const value = await fetchJson('/ams/api/projects')
          setItems(value && Array.isArray(value.data) ? value.data : [])
          const jobValue = await fetchJson('/ams/api/jobs')
          const list = jobValue && Array.isArray(jobValue.data) ? jobValue.data : []
          setJobs(list)
        } catch (error) { setMessage('读取工程失败：' + String(error && error.message ? error.message : error)) }
      }
      React.useEffect(() => { void refresh() }, [])
      const create = async () => {
        if (!name.trim()) { setMessage('请填写工程名'); return }
        try {
          const value = await fetchJson('/ams/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) })
          setCurrent(value.data.id); window.localStorage.setItem('ams.currentProject', value.data.id)
          setName(''); setMessage('已创建并选中：' + value.data.name); await refresh()
        } catch (error) { setMessage('创建失败：' + String(error && error.message ? error.message : error)) }
      }
      const importProject = () => {
        const picker = document.createElement('input'); picker.type='file'; picker.accept='.zip'; picker.style.display='none'; document.body.appendChild(picker)
        picker.onchange = async () => {
          const file=picker.files&&picker.files[0]; picker.remove(); if(!file) return
          try {
            const response=await fetch('/ams/api/upload?name='+encodeURIComponent(file.name),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/octet-stream'},body:file})
            const text=await response.text(); const body=text?JSON.parse(text):null; if(!response.ok||!body||!body.data||!body.data.path) throw new Error('上传失败')
            const result=await fetchJson('/ams/api/projects-import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({archive_path:body.data.path})})
            setMessage('已导入工程：'+result.data.name); await refresh()
          } catch(error){ setMessage('导入失败：'+String(error&&error.message?error.message:error)) }
        }
        picker.click()
      }
      const select = item => { setCurrent(item.id); window.localStorage.setItem('ams.currentProject', item.id); setMessage('当前工程：' + item.name) }
      const trash = async item => {
        if (!window.confirm('把工程 ' + item.name + ' 移入 data/trash？')) return
        try { await fetchJson('/ams/api/projects-trash', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id }) }); if (current === item.id) { setCurrent(''); window.localStorage.removeItem('ams.currentProject') }; setMessage('已移入回收站'); await refresh() } catch (error) { setMessage('移动失败：' + String(error && error.message ? error.message : error)) }
      }
      const exportProject = async item => {
        try { const value = await fetchJson('/ams/api/projects-export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id }) }); setMessage('已导出：' + value.data.path) } catch (error) { setMessage('导出失败：' + String(error && error.message ? error.message : error)) }
      }
      const currentName = (items.find(item => item.id === current) || {}).name || '未选择'
      const currentJobs = jobs.filter(job => job.project_id === current)
      return h('div', null,
        h('div', { style: { color: COLORS.muted, fontSize: 12, marginBottom: 10 } }, '当前工程：' + currentName + '；提交任务时会自动带 project_id。删除只移到 data/trash。'),
        h('div', { style: cardStyle() },
          h('h2', { style: { fontSize: 16, marginTop: 0 } }, '新建工程'),
          h('input', { value: name, onChange: e => setName(e.target.value), placeholder: '工程名', style: { width: '100%', padding: 7, marginBottom: 6, background: COLORS.bg, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 5 } }),
          h('button', { onClick: () => void create(), style: { background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 5, padding: '5px 12px' } }, '创建并选中'),
          h('button', { onClick: importProject, style: { marginLeft: 8, background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '5px 12px' } }, '导入工程包'),
          message ? h('div', { style: { color: message.indexOf('失败') >= 0 ? COLORS.err : COLORS.ok, fontSize: 12, marginTop: 6 } }, message) : null),
        items.length === 0 ? h('div', { style: { color: COLORS.muted } }, '暂无工程。') : h('div', null, items.map(item => h('div', { key: item.id, style: { border: '1px solid ' + COLORS.border, borderRadius: 7, padding: 10, marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('b', null, item.name), h('span', { style: { color: COLORS.muted, fontSize: 12 } }, item.id + ' · ' + jobs.filter(job => job.project_id === item.id).length + ' 个任务'),
          h('button', { onClick: () => select(item), style: { marginLeft: 'auto', background: current === item.id ? COLORS.ok : COLORS.accent, color: '#fff', border: 'none', borderRadius: 5, padding: '3px 8px' } }, current === item.id ? '当前' : '选择'),
          h('button', { onClick: () => void exportProject(item), style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '3px 8px' } }, '导出工程'),
          h('button', { onClick: () => void trash(item), style: { background: 'transparent', color: COLORS.err, border: '1px solid ' + COLORS.err, borderRadius: 5, padding: '3px 8px' } }, '移入回收站')))),
        h('div', { style: { color: COLORS.muted, fontSize: 12, marginTop: 10 } }, '当前工程关联任务：' + currentJobs.length + ' 个' + (currentJobs.length ? '（' + currentJobs.map(job => job.type + ':' + job.status).join(', ') + '）' : '')))
    }


    function MixTrackPanel(props) {
      const [rows, setRows] = React.useState([{ path: '', gain: '0', pan: '0', low: '0', mid: '0', high: '0', hp: '', lp: '', mute: '0' }, { path: '', gain: '0', pan: '0', low: '0', mid: '0', high: '0', hp: '', lp: '', mute: '0' }])
      const [compressor, setCompressor] = React.useState(true)
      const [loudness, setLoudness] = React.useState('-14')
      const [peak, setPeak] = React.useState('-1')
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const update = (index, key, value) => setRows(previous => previous.map((row, i) => i === index ? Object.assign({}, row, { [key]: value }) : row))
      const submit = async () => {
        const tracks = rows.filter(row => row.path.trim())
        if (!tracks.length) { setMessage('至少填写一轨音频路径'); return }
        setBusy(true)
        const params = { input_paths: tracks.map(row => row.path.trim()).join(';'), track_gains: tracks.map(row => row.gain).join(','), track_pans: tracks.map(row => row.pan).join(','), eq_low: tracks.map(row => row.low).join(','), eq_mid: tracks.map(row => row.mid).join(','), eq_high: tracks.map(row => row.high).join(','), highpass: tracks.map(row => row.hp).join(','), lowpass: tracks.map(row => row.lp).join(','), track_mutes: tracks.map(row => row.mute).join(','), compressor: compressor ? 'true' : 'false', loudness, true_peak: peak }
        const result = await props.consoleState.submitJob('mix.master', params)
        setBusy(false); setMessage(result.ok ? '已提交混音任务 ' + result.job.id : '提交失败：' + result.message)
      }
      return h('div', null,
        h('div', { style: { color: COLORS.muted, fontSize: 12, marginBottom: 10 } }, '逐轨可视化：每行一轨，独立增益/声像/三段 EQ；输出响度归一 + 限幅。'),
        rows.map((row, index) => h('div', { key: index, style: { border: '1px solid ' + COLORS.border, borderRadius: 7, padding: 8, marginBottom: 8 } },
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, h('b', null, '轨 ' + (index + 1)), h('input', { value: row.path, onChange: e => update(index, 'path', e.target.value), placeholder: '音频路径', style: { flex: 1, padding: 5, background: COLORS.bg, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 4 } }), rows.length > 1 ? h('button', { onClick: () => setRows(previous => previous.filter((_, i) => i !== index)), style: { color: COLORS.err, background: 'transparent', border: '1px solid ' + COLORS.err, borderRadius: 4 } }, '删除') : null),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } }, [['gain', '增益 dB'], ['pan', '声像'], ['low', '低 100Hz'], ['mid', '中 1kHz'], ['high', '高 8kHz'], ['hp', 'HP Hz'], ['lp', 'LP Hz'], ['mute', '静音 1/0']].map(([key, label]) => h('label', { key, style: { color: COLORS.muted, fontSize: 11 } }, label, h('input', { value: row[key], onChange: e => update(index, key, e.target.value), style: { width: 72, marginLeft: 4, padding: 3, background: COLORS.bg, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 4 } })))))),
        h('button', { onClick: () => setRows(previous => previous.concat([{ path: '', gain: '0', pan: '0', low: '0', mid: '0', high: '0', hp: '', lp: '', mute: '0' }])), style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '4px 10px' } }, '添加轨道'),
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 } }, h('label', { style: { color: COLORS.muted } }, 'LUFS', h('input', { value: loudness, onChange: e => setLoudness(e.target.value), style: { width: 60, marginLeft: 4 } })), h('label', { style: { color: COLORS.muted } }, '峰值', h('input', { value: peak, onChange: e => setPeak(e.target.value), style: { width: 60, marginLeft: 4 } })), h('label', { style: { color: COLORS.muted } }, h('input', { type: 'checkbox', checked: compressor, onChange: e => setCompressor(e.target.checked) }), ' 总线压缩'), h('button', { disabled: busy, onClick: () => void submit(), style: { background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 5, padding: '5px 12px' } }, busy ? '提交中…' : '开始混音')),
        message ? h('div', { style: { color: message.indexOf('失败') >= 0 ? COLORS.err : COLORS.ok, fontSize: 12, marginTop: 6 } }, message) : null)
    }

    function DatasetStudioPanel(props) {
      const [items, setItems] = React.useState([])
      const [source, setSource] = React.useState('')
      const [name, setName] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const refresh = async () => {
        try { const value = await fetchJson('/ams/api/datasets'); setItems(value && Array.isArray(value.data) ? value.data : []) } catch (error) { setMessage('读取数据集失败：' + String(error && error.message ? error.message : error)) }
      }
      React.useEffect(() => { void refresh() }, [])
      const create = async () => {
        if (!source.trim() || !name.trim()) { setMessage('请填写源路径和名称'); return }
        setBusy(true)
        const result = await props.consoleState.submitJob('dataset.prepare', { source_path: source.trim(), dataset_name: name.trim(), target_sr: 48000, min_sec: 3, max_sec: 10 })
        setBusy(false)
        setMessage(result.ok ? '已提交数据集任务 ' + result.job.id : '提交失败：' + result.message)
        if (result.ok) { await refresh() }
      }
      const rename = async item => {
        const value = window.prompt('新数据集名称', item.name)
        if (!value || value === item.name) return
        try { await fetchJson('/ams/api/dataset-rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: item.name, new_name: value }) }); await refresh(); setMessage('已重命名：' + value) } catch (error) { setMessage('重命名失败：' + String(error && error.message ? error.message : error)) }
      }
      const trash = async item => {
        if (!window.confirm('把数据集 ' + item.name + ' 移入 data/trash？')) return
        try { await fetchJson('/ams/api/dataset-trash', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: item.name }) }); await refresh(); setMessage('已移入回收站：' + item.name) } catch (error) { setMessage('移动失败：' + String(error && error.message ? error.message : error)) }
      }
      return h('div', null,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 } },
          h('button', { onClick: () => void refresh(), style: { background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 5, padding: '5px 10px' } }, '刷新'),
          h('span', { style: { color: COLORS.muted, fontSize: 12 } }, '删除只移到 data/trash；训练在“音源炼制”页选择 processed 目录。')),
        h('div', { style: cardStyle() },
          h('h2', { style: { fontSize: 16, marginTop: 0 } }, '新建数据集'),
          h('input', { value: source, onChange: e => setSource(e.target.value), placeholder: '源 wav 文件或目录（可用上传后的路径）', style: { width: '100%', padding: 7, marginBottom: 6, background: COLORS.bg, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 5 } }),
          h('input', { value: name, onChange: e => setName(e.target.value), placeholder: '数据集名称', style: { width: '100%', padding: 7, marginBottom: 6, background: COLORS.bg, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 5 } }),
          h('button', { disabled: busy, onClick: () => void create(), style: { background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 5, padding: '5px 12px' } }, busy ? '提交中…' : '准备数据集'),
          message ? h('div', { style: { color: message.indexOf('失败') >= 0 ? COLORS.err : COLORS.ok, fontSize: 12, marginTop: 6 } }, message) : null),
        items.length === 0 ? h('div', { style: { color: COLORS.muted, fontSize: 13 } }, '暂无数据集。') : h('div', null, items.map(item => h('div', { key: item.name, style: { border: '1px solid ' + COLORS.border, borderRadius: 7, padding: 10, marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('b', null, item.name), h('span', { style: { color: COLORS.muted, fontSize: 12 } }, item.clip_count + ' 段 / ' + Math.round(item.total_seconds) + ' 秒'),
          h('button', { onClick: () => props.onUse(item), style: { marginLeft: 'auto', background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 5, padding: '3px 8px' } }, '用于训练'),
          h('button', { onClick: () => void rename(item), style: { background: 'transparent', color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 5, padding: '3px 8px' } }, '重命名'),
          h('button', { onClick: () => void trash(item), style: { background: 'transparent', color: COLORS.err, border: '1px solid ' + COLORS.err, borderRadius: 5, padding: '3px 8px' } }, '移入回收站')))))
    }

    function TtsBatchPanel(props) {
      const models = props.models || []
      const busy = props.busy
      const message = props.message
      const [text, setText] = React.useState('')
      const [selected, setSelected] = React.useState([])
      const toggle = value => setSelected(previous => previous.indexOf(value) >= 0 ? previous.filter(item => item !== value) : previous.concat([value]))
      return h('div', { style: cardStyle() },
        h('div', { style: { color: COLORS.muted, fontSize: 12, marginBottom: 10 } }, '同一段文本批量合成到多个 TTS 模型；每个模型生成独立任务和产物。'),
        h('textarea', { value: text, onChange: event => setText(event.target.value), placeholder: '输入文本（最多 2000 字）', style: { width: '100%', minHeight: 100, padding: 8, borderRadius: 6, border: '1px solid ' + COLORS.border, background: COLORS.bg, color: COLORS.text } }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 10 } }, models.map(item => h('label', { key: item.value, style: { color: COLORS.text, fontSize: 12 } }, h('input', { type: 'checkbox', checked: selected.indexOf(item.value) >= 0, onChange: () => toggle(item.value) }), ' ' + item.label))),
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 } },
          h('button', { type: 'button', disabled: busy || !text.trim() || selected.length === 0, onClick: () => props.onSubmit(text, selected), style: { background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 13 } }, busy ? '提交中…' : '批量合成'),
          h('span', { style: { color: COLORS.muted, fontSize: 12 } }, '已选 ' + selected.length + ' 个模型'),
          message ? h('span', { style: { color: message.ok ? COLORS.ok : COLORS.err, fontSize: 12 } }, message.text) : null)
      )
    }
    function VoiceLibrary(props) {
      const items = props.items || []
      const meta = props.meta || {}
      const busy = props.busy
      const onChange = props.onChange
      const onSave = props.onSave
      const onTrash = props.onTrash
      const onUse = props.onUse
      const onOpen = props.onOpen
      const onPreview = props.onPreview
      const onBindIndex = props.onBindIndex
      const onUnbindIndex = props.onUnbindIndex
      const onImport = props.onImport
      const onExport = props.onExport
      const previews = props.previews || {}
      return h('div', null,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 } },
          h('span', { style: { color: COLORS.muted, fontSize: 12 } }, '共 ' + items.length + ' 个音源；删除只移动到 data/trash，不物理删除。'),
          h('button', { type: 'button', onClick: onOpen, style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '4px 10px', fontSize: 12 } }, '打开音源目录'),
          h('button', { type: 'button', onClick: onImport, style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '4px 10px', fontSize: 12 } }, '导入 voicepack')),
        items.length === 0 ? h('div', { style: { color: COLORS.warn, fontSize: 13 } }, '音源目录为空。请用启动器安装或放入 data/voices/<名称>/<名称>.pth。') : null,
        items.map(item => {
          const m = meta[item.name] || { tags: [], note: '', favorite: false }
          const tags = Array.isArray(m.tags) ? m.tags.join(', ') : ''
          return h('div', { key: item.name, style: { border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 12, marginBottom: 10 } },
            h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
              h('b', { style: { fontSize: 14 } }, item.name),
              h('span', { style: { color: item.status === 'ok' ? COLORS.ok : COLORS.warn, fontSize: 12 } }, item.status),
              h('span', { style: { color: COLORS.muted, fontSize: 12 } }, item.index ? 'index：有' : 'index：无'),
              h('label', { style: { color: COLORS.muted, fontSize: 12 } }, h('input', { type: 'checkbox', checked: Boolean(m.favorite), onChange: e => onChange(item.name, 'favorite', e.target.checked) }), ' 收藏'),
              h('button', { type: 'button', disabled: busy, onClick: () => onUse(item), style: { background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 5, padding: '4px 9px', fontSize: 12 } }, '用于歌曲换源'),
              h('button', { type: 'button', disabled: busy, onClick: () => onPreview(item), style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '4px 9px', fontSize: 12 } }, '试听'),
              h('button', { type: 'button', disabled: busy, onClick: () => onBindIndex(item.name), style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '4px 9px', fontSize: 12 } }, '绑定 index'),
              h('button', { type: 'button', disabled: busy, onClick: () => onExport(item.name), style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '4px 9px', fontSize: 12 } }, '导出 voicepack'),
              item.index ? h('button', { type: 'button', disabled: busy, onClick: () => onUnbindIndex(item.name), style: { background: 'transparent', color: COLORS.warn, border: '1px solid ' + COLORS.warn, borderRadius: 5, padding: '4px 9px', fontSize: 12 } }, '解绑 index') : null,
              h('button', { type: 'button', disabled: busy, onClick: () => onTrash(item.name), style: { background: 'transparent', color: COLORS.err, border: '1px solid ' + COLORS.err, borderRadius: 5, padding: '4px 9px', fontSize: 12 } }, '移入回收站')),
            previews[item.name] ? h('audio', { controls: true, src: previews[item.name], style: { width: '100%', marginTop: 6 } }) : null,
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
              h('span', { style: { color: COLORS.muted, fontSize: 12, width: 38 } }, '标签'),
              h('input', { value: tags, placeholder: '用逗号分隔', onChange: e => onChange(item.name, 'tags', e.target.value.split(',').map(v => v.trim()).filter(Boolean)), style: { flex: 1, padding: '4px 6px', borderRadius: 5, border: '1px solid ' + COLORS.border, background: COLORS.bg, color: COLORS.text } })),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
              h('span', { style: { color: COLORS.muted, fontSize: 12, width: 38 } }, '备注'),
              h('input', { value: m.note || '', placeholder: '备注', onChange: e => onChange(item.name, 'note', e.target.value), style: { flex: 1, padding: '4px 6px', borderRadius: 5, border: '1px solid ' + COLORS.border, background: COLORS.bg, color: COLORS.text } }),
              h('button', { type: 'button', disabled: busy, onClick: () => onSave(item.name), style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '3px 8px', fontSize: 12 } }, '保存元数据')))
        })
      )
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
      const [templates, setTemplates] = React.useState([])
      const [libraryVoices, setLibraryVoices] = React.useState([])
      const [voiceMeta, setVoiceMeta] = React.useState({})
      const [libraryBusy, setLibraryBusy] = React.useState(false)
      const [voicePreviews, setVoicePreviews] = React.useState({})
      const [previewBusy, setPreviewBusy] = React.useState(null)
      const [jobAudioUrl, setJobAudioUrl] = React.useState('')
      const [abPairs, setAbPairs] = React.useState(() => { try { return JSON.parse(window.localStorage.getItem('ams.abPairs') || '{}') } catch { return {} } })
      const [jobParams, setJobParams] = React.useState(() => { try { return JSON.parse(window.localStorage.getItem('ams.jobParams') || '{}') } catch { return {} } })
      const [batchItems, setBatchItems] = React.useState([])
      const [abOriginal, setAbOriginal] = React.useState('')
      const [abConverted, setAbConverted] = React.useState('')
      const [eBusy, setEBusy] = React.useState(false)
      const [ttsBatchBusy, setTtsBatchBusy] = React.useState(false)
      const [ttsBatchMessage, setTtsBatchMessage] = React.useState(null)
      const [cancelBusy, setCancelBusy] = React.useState(null)
      const [connection, setConnection] = React.useState(null)
      const [connBase, setConnBase] = React.useState('')
      const [connKey, setConnKey] = React.useState('')
      const [connBusy, setConnBusy] = React.useState(false)
      const [connMessage, setConnMessage] = React.useState('')
      const [vcDevices, setVcDevices] = React.useState(null)
      const [vcStatus, setVcStatus] = React.useState({})
      const [vcForm, setVcForm] = React.useState({ mode: 'rvc', f0method: 'rmvpe', pitch: '0', index_rate: '0', block_time: '0.1', extra_time: '0.25', latency_mode: 'low', monitor_device: '', mix_loopback: '' })
      const [vcBusy, setVcBusy] = React.useState(false)
      const [vcMessage, setVcMessage] = React.useState(null)

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
            setLibraryVoices(list)
            setVoices(list.map(voice => ({ label: voice.name, value: voice.pth && voice.pth.file ? voice.pth.file : voice.name, index: voice.index && voice.index.file ? voice.index.file : '' })))
            try {
              const metaValue = await fetchJson('/ams/api/voice-meta')
              const entries = metaValue && metaValue.data && Array.isArray(metaValue.data.voices) ? metaValue.data.voices : []
              const map = {}
              for (const entry of entries) map[entry.name] = entry
              setVoiceMeta(map)
            } catch (error) { /* metadata optional */ }
          } catch (error) { /* voices are optional */ }
          try {
            const value = await fetchJson('/ams/api/tts/models')
            const list = value && value.data && Array.isArray(value.data.models) ? value.data.models : []
            setTtsModels(list.map(model => ({ label: model.name, value: model.path })))
          } catch (error) { /* tts models are optional */ }
          try {
            const value = await fetchJson('/ams/api/templates')
            setTemplates(value && value.data && Array.isArray(value.data) ? value.data : [])
          } catch (error) { /* templates are optional */ }
        })()
      }, [])

      React.useEffect(() => {
        if (voices.length === 0) return
        setForms(previous => {
          if (previous.convert && previous.convert.voice_name) return previous
          return Object.assign({}, previous, { convert: Object.assign({}, previous.convert, { voice_name: voices[0].value }) })
        })
      }, [voices])

      const refreshVc = React.useCallback(async (loadDevices) => {
        try {
          if (loadDevices) {
            const value = await fetchJson('/ams/api/vc/devices')
            const devices = value && value.data ? value.data : null
            setVcDevices(devices)
            if (devices) {
              setVcForm(previous => {
                const next = Object.assign({}, previous)
                if (!next.input_device) {
                  const choices = Array.isArray(devices.input_choices) ? devices.input_choices : []
                  const preferredInput = choices.find(item => item.is_default) || choices[0]
                  next.input_device = String(preferredInput ? preferredInput.index : (devices.default_input >= 0 ? devices.default_input : (devices.inputs[0] ? devices.inputs[0].index : '')))
                }
                if (!next.output_device) {
                  const choices = Array.isArray(devices.output_choices) ? devices.output_choices : []
                  const virtualChoice = choices.find(item => item.is_virtual)
                  const preferred = virtualChoice ? virtualChoice.index : (devices.virtual_outputs && devices.virtual_outputs.length ? devices.virtual_outputs[0].index : devices.default_output)
                  next.output_device = String(preferred >= 0 ? preferred : '')
                }
                return next
              })
            }
          }
          const status = await fetchJson('/ams/api/vc/status')
          setVcStatus(status && status.data ? status.data : {})
          setVcMessage(previous => previous && previous.ok ? previous : null)
        } catch (error) {
          setVcMessage({ ok: false, text: 'VC 服务不可用：' + String(error && error.message ? error.message : error) })
        }
      }, [])

      React.useEffect(() => {
        if (activeTab !== 'realtime') return undefined
        void refreshVc(true)
        const timer = setInterval(() => { void refreshVc(false) }, 2000)
        return () => clearInterval(timer)
      }, [activeTab, refreshVc])

      React.useEffect(() => {
        if (voices.length === 0) return
        setVcForm(previous => previous.voice ? previous : Object.assign({}, previous, { voice: voices[0].value }))
      }, [voices])

      const startVc = async () => {
        if (!vcForm.voice && vcForm.mode !== 'passthrough') { setVcMessage({ ok: false, text: '请先选择目标音色' }); return }
        setVcBusy(true); setVcMessage(null)
        try {
          const value = await fetchJson('/ams/api/vc/session/start', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.assign({}, vcForm, { pitch: Number(vcForm.pitch || 0), index_rate: Number(vcForm.index_rate || 0) }))
          })
          setVcStatus(value && value.data ? value.data : {})
          setVcMessage({ ok: true, text: '实时变声已启动' })
        } catch (error) { setVcMessage({ ok: false, text: '启动失败：' + String(error && error.message ? error.message : error) }) }
        finally { setVcBusy(false) }
      }

      const switchVc = async () => {
        if (!vcForm.voice) { setVcMessage({ ok: false, text: '请先选择目标音色' }); return }
        setVcBusy(true); setVcMessage(null)
        try {
          const value = await fetchJson('/ams/api/vc/session/switch-voice', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.assign({}, vcForm, { pitch: Number(vcForm.pitch || 0), index_rate: Number(vcForm.index_rate || 0) }))
          })
          setVcStatus(value && value.data ? value.data : {})
          setVcMessage({ ok: true, text: '音色已切换（服务会短暂重启音频流）' })
        } catch (error) { setVcMessage({ ok: false, text: '切换失败：' + String(error && error.message ? error.message : error) }) }
        finally { setVcBusy(false) }
      }

      const stopVc = async () => {
        setVcBusy(true); setVcMessage(null)
        try {
          const value = await fetchJson('/ams/api/vc/session/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          setVcStatus(value && value.data ? value.data : {})
          setVcMessage({ ok: true, text: '实时变声已停止' })
        } catch (error) { setVcMessage({ ok: false, text: '停止失败：' + String(error && error.message ? error.message : error) }) }
        finally { setVcBusy(false) }
      }
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

      const templateKind = activeTab === 'separate' ? 'pymss' : (activeTab === 'convert' ? 'rvc' : (activeTab === 'tts' ? 'tts' : (activeTab === 'msvc' ? 'msvc' : '')))
      const activeTemplates = templates.filter(item => item.kind === templateKind)
      const saveTemplate = async (name, params) => {
        try {
          await fetchJson('/ams/api/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: templateKind, name, params }) })
          const value = await fetchJson('/ams/api/templates')
          setTemplates(value && value.data && Array.isArray(value.data) ? value.data : [])
          setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: true, text: '模板已保存：' + name } }))
        } catch (error) { setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: false, text: '模板保存失败：' + String(error && error.message ? error.message : error) } })) }
      }
      const applyTemplate = params => {
        setForms(previous => Object.assign({}, previous, { [activeTab]: Object.assign({}, previous[activeTab], params) }))
        setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: true, text: '已应用模板参数' } }))
      }
      const deleteTemplate = async name => {
        try {
          await fetchJson('/ams/api/templates', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: templateKind, name }) })
          const value = await fetchJson('/ams/api/templates')
          setTemplates(value && value.data && Array.isArray(value.data) ? value.data : [])
          setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: true, text: '模板已移入 data/trash：' + name } }))
        } catch (error) { setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: false, text: '模板删除失败：' + String(error && error.message ? error.message : error) } })) }
      }
      const changeVoiceMeta = (name, key, value) => {
        setVoiceMeta(previous => Object.assign({}, previous, { [name]: Object.assign({ name, tags: [], note: '', favorite: false }, previous[name], { [key]: value }) }))
      }
      const saveVoiceMeta = async name => {
        setLibraryBusy(true)
        try {
          const item = voiceMeta[name] || { name, tags: [], note: '', favorite: false }
          const value = await fetchJson('/ams/api/voice-meta', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, tags: item.tags || [], note: item.note || '', favorite: Boolean(item.favorite) }) })
          setVoiceMeta(previous => Object.assign({}, previous, { [name]: value.data }))
          setMessages(previous => Object.assign({}, previous, { library: { ok: true, text: '已保存音色元数据：' + name } }))
        } catch (error) { setMessages(previous => Object.assign({}, previous, { library: { ok: false, text: '保存失败：' + String(error && error.message ? error.message : error) } })) }
        finally { setLibraryBusy(false) }
      }
      const trashVoice = async name => {
        if (!window.confirm('将音色 ' + name + ' 移入 data/trash？不会直接删除。')) return
        setLibraryBusy(true)
        try {
          await fetchJson('/ams/api/voice-trash', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
          setLibraryVoices(previous => previous.filter(item => item.name !== name))
          setVoices(previous => previous.filter(item => item.label !== name))
          setMessages(previous => Object.assign({}, previous, { library: { ok: true, text: '已移入 data/trash：' + name } }))
        } catch (error) { setMessages(previous => Object.assign({}, previous, { library: { ok: false, text: '移动失败：' + String(error && error.message ? error.message : error) } })) }
        finally { setLibraryBusy(false) }
      }
      const useLibraryVoice = item => {
        const value = item.pth && item.pth.file ? item.pth.file : item.name
        setForms(previous => Object.assign({}, previous, { convert: Object.assign({}, previous.convert, { voice_name: value }) }))
        setActiveTab('convert')
        setMessages(previous => Object.assign({}, previous, { convert: { ok: true, text: '已选择音色：' + item.name } }))
      }
      const submitTtsBatch = async (text, models) => {
        if (!text.trim() || models.length === 0) return
        setTtsBatchBusy(true)
        const ids = []
        const errors = []
        for (const model of models) {
          const result = await consoleState.submitJob('tts.synthesize', { text: text.trim(), model })
          if (result.ok) ids.push(result.job.id); else errors.push(model + ': ' + result.message)
        }
        setTtsBatchBusy(false)
        setTtsBatchMessage(ids.length > 0 ? { ok: errors.length === 0, text: '已提交 ' + ids.length + ' 个任务：' + ids.join(', ') + (errors.length ? '；失败：' + errors.join('; ') : '') } : { ok: false, text: errors.join('; ') || '提交失败' })
      }
      const previewLibraryVoice = async item => {
        setPreviewBusy(item.name)
        try {
          const value = await fetchJson('/ams/api/voice-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice_name: item.pth && item.pth.file ? item.pth.file : item.name }) })
          const artifacts = value && value.data && Array.isArray(value.data.artifacts) ? value.data.artifacts : []
          const audio = artifacts.find(entry => String(entry.kind || '').indexOf('audio') >= 0 || String(entry.name || '').toLowerCase().endsWith('.wav')) || artifacts[0]
          if (!audio || !audio.id) throw new Error('试听任务没有音频产物')
          setVoicePreviews(previous => Object.assign({}, previous, { [item.name]: '/ams/api/artifact/' + audio.id }))
          setMessages(previous => Object.assign({}, previous, { library: { ok: true, text: '试听已生成：' + item.name } }))
        } catch (error) { setMessages(previous => Object.assign({}, previous, { library: { ok: false, text: '试听失败：' + String(error && error.message ? error.message : error) } })) }
        finally { setPreviewBusy(null) }
      }
      const refreshLibrary = async () => {
        const value = await fetchJson('/ams/api/voices')
        const list = value && value.data && Array.isArray(value.data.voices) ? value.data.voices : []
        setLibraryVoices(list)
        setVoices(list.map(voice => ({ label: voice.name, value: voice.pth && voice.pth.file ? voice.pth.file : voice.name, index: voice.index && voice.index.file ? voice.index.file : '' })))
      }
      const pickVoiceIndex = name => {
        const picker = document.createElement('input')
        picker.type = 'file'; picker.accept = '.index'; picker.style.display = 'none'
        document.body.appendChild(picker)
        picker.onchange = async () => {
          const file = picker.files && picker.files[0]
          picker.remove()
          if (!file) return
          setLibraryBusy(true)
          try {
            const response = await fetch('/ams/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file })
            const text = await response.text(); let body = null
            try { body = text ? JSON.parse(text) : null } catch { body = null }
            if (!response.ok || !body || !body.data || !body.data.path) throw new Error(body && body.error && body.error.message ? body.error.message : '上传失败')
            await fetchJson('/ams/api/voice-index', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, index_path: body.data.path }) })
            await refreshLibrary()
            setMessages(previous => Object.assign({}, previous, { library: { ok: true, text: '已绑定 index：' + name } }))
          } catch (error) { setMessages(previous => Object.assign({}, previous, { library: { ok: false, text: '绑定失败：' + String(error && error.message ? error.message : error) } })) }
          finally { setLibraryBusy(false) }
        }
        picker.click()
      }
      const unbindVoiceIndex = async name => {
        if (!window.confirm('把 index 移入 data/trash？音色仍可用，index_rate 将失效。')) return
        setLibraryBusy(true)
        try {
          await fetchJson('/ams/api/voice-index', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, index_path: '' }) })
          await refreshLibrary()
          setMessages(previous => Object.assign({}, previous, { library: { ok: true, text: '已解绑 index：' + name } }))
        } catch (error) { setMessages(previous => Object.assign({}, previous, { library: { ok: false, text: '解绑失败：' + String(error && error.message ? error.message : error) } })) }
        finally { setLibraryBusy(false) }
      }
      const importVoicepack = () => {
        const picker = document.createElement('input')
        picker.type = 'file'; picker.accept = '.zip'; picker.style.display = 'none'
        document.body.appendChild(picker)
        picker.onchange = async () => {
          const file = picker.files && picker.files[0]
          picker.remove()
          if (!file) return
          setLibraryBusy(true)
          try {
            const response = await fetch('/ams/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file })
            const text = await response.text(); let body = null
            try { body = text ? JSON.parse(text) : null } catch { body = null }
            if (!response.ok || !body || !body.data || !body.data.path) throw new Error(body && body.error && body.error.message ? body.error.message : '上传失败')
            const base = file.name.replace(/\.zip$/i, '')
            const name = window.prompt('导入后的音色名称', base) || base
            const result = await fetchJson('/ams/api/voice-import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archive_path: body.data.path, name }) })
            await refreshLibrary()
            setMessages(previous => Object.assign({}, previous, { library: { ok: true, text: '已导入音色：' + result.data.name } }))
          } catch (error) { setMessages(previous => Object.assign({}, previous, { library: { ok: false, text: '导入失败：' + String(error && error.message ? error.message : error) } })) }
          finally { setLibraryBusy(false) }
        }
        picker.click()
      }
      const exportVoicepack = async name => {
        setLibraryBusy(true)
        try {
          const result = await fetchJson('/ams/api/voice-export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
          setMessages(previous => Object.assign({}, previous, { library: { ok: true, text: '已导出：' + result.data.path } }))
        } catch (error) { setMessages(previous => Object.assign({}, previous, { library: { ok: false, text: '导出失败：' + String(error && error.message ? error.message : error) } })) }
        finally { setLibraryBusy(false) }
      }
      const importTemplate = kind => {
        const picker = document.createElement('input')
        picker.type = 'file'; picker.accept = '.json'; picker.style.display = 'none'
        document.body.appendChild(picker)
        picker.onchange = async () => {
          const file = picker.files && picker.files[0]
          picker.remove()
          if (!file) return
          try {
            const text = await file.text()
            const parsed = JSON.parse(text)
            const params = parsed.params || parsed
            const name = window.prompt('导入模板名称', parsed.name || file.name.replace(/\.json$/i, ''))
            if (!name) return
            await fetchJson('/ams/api/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, name, params }) })
            const value = await fetchJson('/ams/api/templates')
            setTemplates(value && value.data && Array.isArray(value.data) ? value.data : [])
            setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: true, text: '已导入模板：' + name } }))
          } catch (error) { setMessages(previous => Object.assign({}, previous, { [activeTab]: { ok: false, text: '模板导入失败：' + String(error && error.message ? error.message : error) } })) }
        }
        picker.click()
      }

      const useSeparatedJob = async jobId => {
        setEBusy(true)
        try {
          const value = await fetchJson('/ams/api/job-artifacts/' + jobId)
          const list = value && Array.isArray(value.data) ? value.data : []
          const vocals = list.find(item => String(item.meta && item.meta.stem ? item.meta.stem : '').toLowerCase() === 'vocals') || list.find(item => String(item.name || '').toLowerCase().indexOf('vocal') >= 0)
          if (!vocals || !vocals.path) throw new Error('该分离任务没有 vocals 产物')
          setForms(previous => Object.assign({}, previous, { convert: Object.assign({}, previous.convert, { input_path: vocals.path }) }))
          setActiveTab('convert')
          setMessages(previous => Object.assign({}, previous, { convert: { ok: true, text: '已填入分离人声：' + vocals.name } }))
        } catch (error) { setMessages(previous => Object.assign({}, previous, { jobs: { ok: false, text: '回填失败：' + String(error && error.message ? error.message : error) } })) }
        finally { setEBusy(false) }
      }
      const exportJob = async jobId => {
        setEBusy(true)
        try {
          const value = await fetchJson('/ams/api/job-export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: jobId }) })
          setMessages(previous => Object.assign({}, previous, { jobs: { ok: true, text: '已导出纯人声：' + (value.data && value.data.path ? value.data.path : '') } }))
        } catch (error) { setMessages(previous => Object.assign({}, previous, { jobs: { ok: false, text: '导出失败：' + String(error && error.message ? error.message : error) } })) }
        finally { setEBusy(false) }
      }
      const showAB = jobId => {
        const original = abPairs[jobId]
        if (!original) { setMessages(previous => Object.assign({}, previous, { jobs: { ok: false, text: 'A/B 需要本次页面提交的换源任务；刷新后缺少原声路径' } })); return }
        setAbOriginal('/ams/api/audio?path=' + encodeURIComponent(original))
        setAbConverted('/ams/api/job-audio/' + jobId)
      }

      const retryJob = async job => {
        let params = jobParams[job.id]
        if (!params) { try { params = JSON.parse(window.localStorage.getItem('ams.jobParams') || '{}')[job.id] } catch { params = null } }
        if (!params) { setMessages(previous => Object.assign({}, previous, { jobs: { ok: false, text: '缺少该任务的原始参数，无法重试' } })); return }
        const result = await consoleState.submitJob(job.type, params)
        if (result.ok) {
          setJobParams(previous => { const next = Object.assign({}, previous, { [result.job.id]: params }); try { window.localStorage.setItem('ams.jobParams', JSON.stringify(next)) } catch { /* ignore */ } return next })
          setMessages(previous => Object.assign({}, previous, { jobs: { ok: true, text: '已重试：' + result.job.id } }))
        } else setMessages(previous => Object.assign({}, previous, { jobs: { ok: false, text: '重试失败：' + result.message } }))
      }
      const retryBatchItem = async item => {
        if (!item.params) { setMessages(previous => Object.assign({}, previous, { convert: { ok: false, text: '该批次项缺少参数，请重新提交' } })); return }
        const result = await consoleState.submitJob('convert.rvc', item.params)
        setBatchItems(previous => previous.map(entry => entry.path === item.path ? Object.assign({}, entry, { jobId: result.ok ? result.job.id : entry.jobId, ok: result.ok, message: result.ok ? '已重新提交' : result.message, params: item.params }) : entry))
        if (result.ok) {
          setJobParams(previous => { const next = Object.assign({}, previous, { [result.job.id]: item.params }); try { window.localStorage.setItem('ams.jobParams', JSON.stringify(next)) } catch { /* ignore */ } return next })
          setAbPairs(previous => { const next = Object.assign({}, previous, { [result.job.id]: item.path }); try { window.localStorage.setItem('ams.abPairs', JSON.stringify(next)) } catch { /* ignore */ } return next })
        }
      }
      const summary = consoleState.summary
      const gateway = summary && summary.gateway ? summary.gateway : null
      const tools = summary && Array.isArray(summary.tools) ? summary.tools : []
      const jobs = summary && Array.isArray(summary.jobs) ? summary.jobs : []
      const gatewayOk = Boolean(gateway && gateway.ok)
      const tab = activeTab === 'realtime' ? VC_TAB : (activeTab === 'library' ? LIBRARY_TAB : (activeTab === 'tts_batch' ? TTS_BATCH_TAB : (FEATURE_TABS.find(item => item.id === activeTab) || FEATURE_TABS[0])))
      const form = activeTab === 'realtime' ? vcForm : (activeTab === 'library' || activeTab === 'tts_batch' ? {} : forms[tab.id])

      const onChange = (key, value) => {
        if (activeTab === 'realtime') {
          setVcForm(previous => {
            const next = Object.assign({}, previous, { [key]: value })
            if (key === 'voice') {
              const selected = voices.find(item => item.value === value)
              next.index_path = selected && selected.index ? selected.index : ''
            }
            if (key === 'latency_mode') {
              next.block_time = value === 'stable' ? '0.25' : (value === 'ultra' ? '0.05' : '0.1')
              next.extra_time = value === 'stable' ? '1.0' : (value === 'ultra' ? '0.15' : '0.25')
            }
            return next
          })
          return
        }
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
        const missing = tab.fields.find(field => field.required && !(tab.id === 'convert' && field.key === 'input_path' && form.batch_paths && String(form.batch_paths).trim()) && (form[field.key] === undefined || form[field.key] === null || String(form[field.key]).trim() === ''))
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
        if (tab.id === 'convert' && form.batch_paths && String(form.batch_paths).trim()) {
          const paths = String(form.batch_paths).split(/\r?\n/).map(value => value.trim()).filter(Boolean)
          const ids = []
          const errors = []
          for (const path of paths) {
            const item = Object.assign({}, params, { input_path: path })
            delete item.batch_paths
            const result = await consoleState.submitJob('convert.rvc', item)
            if (result.ok) {
            ids.push(result.job.id)
            setAbPairs(previous => { const next = Object.assign({}, previous, { [result.job.id]: path }); try { window.localStorage.setItem('ams.abPairs', JSON.stringify(next)) } catch { /* ignore */ } return next })
            setJobParams(previous => { const next = Object.assign({}, previous, { [result.job.id]: item }); try { window.localStorage.setItem('ams.jobParams', JSON.stringify(next)) } catch { /* ignore */ } return next })
            setBatchItems(previous => previous.concat([{ path, jobId: result.job.id, ok: true, message: '已提交', params: Object.assign({}, item) }]))
          } else { errors.push(path + ': ' + result.message); setBatchItems(previous => previous.concat([{ path, jobId: '', ok: false, message: result.message, params: Object.assign({}, item) }])) }
          }
          setBusyTab(null)
          setMessages(previous => Object.assign({}, previous, { [tab.id]: { ok: errors.length === 0, text: '批量提交 ' + ids.length + ' 个任务' + (errors.length ? '；失败：' + errors.join('; ') : '') } }))
          return
        }
        delete params.batch_paths
        const result = await consoleState.submitJob(tab.jobType, params)
        setBusyTab(null)
        if (result.ok) {
          if (tab.id === 'convert') setAbPairs(previous => { const next = Object.assign({}, previous, { [result.job.id]: params.input_path }); try { window.localStorage.setItem('ams.abPairs', JSON.stringify(next)) } catch { /* ignore */ } return next })
          setJobParams(previous => { const next = Object.assign({}, previous, { [result.job.id]: params }); try { window.localStorage.setItem('ams.jobParams', JSON.stringify(next)) } catch { /* ignore */ } return next })
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
            ALL_TABS.map(item => h('button', {
              key: item.id,
              style: {
                background: item.id === activeTab ? COLORS.accent : 'transparent',
                color: item.id === activeTab ? '#fff' : COLORS.text,
                border: '1px solid ' + (item.id === activeTab ? COLORS.accent : COLORS.border),
                borderRadius: 6, padding: '6px 14px', fontSize: 13, cursor: 'pointer'
              },
              onClick: () => setActiveTab(item.id)
            }, item.label))),
          activeTab === 'project'
            ? h(ProjectPanel, null)
            : activeTab === 'mix'
            ? h(MixTrackPanel, { consoleState: consoleState })
            : activeTab === 'dataset'
            ? h(DatasetStudioPanel, { consoleState: consoleState, onUse: item => { setForms(previous => Object.assign({}, previous, { train: Object.assign({}, previous.train, { dataset_dir: item.path + '\\processed' }) })); setActiveTab('train'); setMessages(previous => Object.assign({}, previous, { train: { ok: true, text: '已选择数据集：' + item.name } })) } })
            : activeTab === 'tts_batch'
            ? h(TtsBatchPanel, { models: ttsModels, busy: ttsBatchBusy, message: ttsBatchMessage, onSubmit: (text, models) => { void submitTtsBatch(text, models) } })
            : activeTab === 'library'
            ? h(VoiceLibrary, { items: libraryVoices, meta: voiceMeta, busy: libraryBusy || previewBusy !== null, previews: voicePreviews, onChange: changeVoiceMeta, onSave: saveVoiceMeta, onTrash: trashVoice, onUse: useLibraryVoice, onPreview: (item) => { void previewLibraryVoice(item) }, onBindIndex: pickVoiceIndex, onUnbindIndex: (name) => { void unbindVoiceIndex(name) }, onImport: importVoicepack, onExport: (name) => { void exportVoicepack(name) }, onOpen: () => { void onOpenFolder('rvc_voices') } })
            : activeTab === 'realtime'
            ? h(VcPanel, {
                devices: vcDevices, status: vcStatus, form: vcForm, busy: vcBusy, message: vcMessage,
                voices: voices, onChange: onChange, onRefresh: () => { void refreshVc(true) }, onStart: () => { void startVc() }, onSwitch: () => { void switchVc() }, onStop: () => { void stopVc() }
              })
            : h(FeatureTab, {
                tab: tab, form: form, summary: summary, message: messages[tab.id],
                busy: busyTab === tab.id, onChange: onChange, onSubmit: onSubmit, onImport: onImport, onOpenFolder: onOpenFolder, onPickFile: onPickFile, dynamicOptions: { voices: voices, ttsModels: ttsModels },
                templates: activeTemplates, onSaveTemplate: saveTemplate, onApplyTemplate: applyTemplate, onDeleteTemplate: deleteTemplate, onImportTemplate: () => importTemplate(templateKind)
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
                    : h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                        job.status === 'succeeded' ? h('button', { type: 'button', onClick: () => setJobAudioUrl('/ams/api/job-audio/' + job.id), style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '2px 7px', fontSize: 12 } }, '试听') : null,
                        job.status === 'succeeded' && job.type === 'separate.pymss' ? h('button', { type: 'button', disabled: eBusy, onClick: () => { void useSeparatedJob(job.id) }, style: { background: 'transparent', color: COLORS.ok, border: '1px solid ' + COLORS.ok, borderRadius: 5, padding: '2px 7px', fontSize: 12 } }, '用于换源') : null,
                        job.status === 'succeeded' && job.type === 'convert.rvc' ? h('button', { type: 'button', disabled: eBusy, onClick: () => { void exportJob(job.id) }, style: { background: 'transparent', color: COLORS.accent, border: '1px solid ' + COLORS.accent, borderRadius: 5, padding: '2px 7px', fontSize: 12 } }, '导出纯人声') : null,
                        job.status === 'succeeded' && job.type === 'convert.rvc' ? h('button', { type: 'button', onClick: () => showAB(job.id), style: { background: 'transparent', color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 5, padding: '2px 7px', fontSize: 12 } }, 'A/B') : null,
                        (job.status === 'failed' || job.status === 'cancelled') ? h('button', { type: 'button', onClick: () => { void retryJob(job) }, style: { background: 'transparent', color: COLORS.warn, border: '1px solid ' + COLORS.warn, borderRadius: 5, padding: '2px 7px', fontSize: 12 } }, '重试') : null,
                        h('span', { style: { color: COLORS.muted } }, '-'))))))),
          jobAudioUrl ? h('div', { style: { marginTop: 10 } }, h('audio', { controls: true, src: jobAudioUrl, style: { width: '100%' } })) : null,
          abOriginal && abConverted ? h('div', { style: { marginTop: 12, padding: 10, border: '1px solid ' + COLORS.border, borderRadius: 7 } },
            h('div', { style: { color: COLORS.muted, fontSize: 12, marginBottom: 6 } }, 'A/B：原声纯人声 / 换源纯人声'),
            h('div', { style: { color: COLORS.text, fontSize: 12 } }, '原声'), h('audio', { controls: true, src: abOriginal, style: { width: '100%', marginBottom: 8 } }),
            h('div', { style: { color: COLORS.text, fontSize: 12 } }, '换源'), h('audio', { controls: true, src: abConverted, style: { width: '100%' } })) : null,
          batchItems.length > 0 ? h('div', { style: { marginTop: 12, padding: 10, border: '1px solid ' + COLORS.border, borderRadius: 7 } },
            h('div', { style: { color: COLORS.muted, fontSize: 12, marginBottom: 6 } }, '批量换源队列'),
            batchItems.map((item, index) => h('div', { key: item.path + index, style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 4 } },
              h('span', { style: { flex: 1, color: item.ok ? COLORS.ok : COLORS.err, overflow: 'hidden', textOverflow: 'ellipsis' } }, item.path),
              h('span', { style: { color: COLORS.muted } }, item.message),
              h('button', { type: 'button', onClick: () => { void retryBatchItem(item) }, style: { background: 'transparent', color: COLORS.warn, border: '1px solid ' + COLORS.warn, borderRadius: 5, padding: '1px 6px' } }, '重试')))) : null),

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
