# @ams/plugin-ui（Client，M1 功能页版）

AMS 音乐插件套件的浏览器侧插件，以 DSH lazy-CJS bundle 加载（lib/client.js：window.__ModuleLoader__.load）。

## 注册内容

| 槽位 | 内容 |
|---|---|
| main（keyed：ams.home） | 多页签音乐工作台：运行状态、5 个功能页签的表单、任务表（含取消）、SSE 实时进度 |
| sidebar.panellist（list，id=ams.home，order=10） | 侧栏入口「AMS 音乐」+ 音符图标 |

## 功能页签

| 页签 | Gateway 类型 | 字段 |
|---|---|---|
| 音源炼制 | train.rvc | dataset_dir / model / epochs / batch_size / sample_rate |
| 人声分离 | separate.pymss | input_path / output_dir |
| 变声器 | convert.rvc | input_path / voice / model / index_path / pitch / f0_method / output_dir |
| 歌曲换源 | convert.msvc | input_path / model / voice / output_dir |
| TTS 占位 | — | 仅占位（M2 接入） |

页面按 /ams/api/summary.jobTypes 显示 Gateway 已注册类型；未注册类型的提交错误原样展示并附提示。

## 数据与鉴权

1. 挂载先 GET /ams/api/session（同源）建立 HttpOnly cookie（Gateway token 不进浏览器）；
2. GET /ams/api/summary 取状态/任务列表；401 自动重申请 session；
3. 选中 active job 后 EventSource('/ams/api/jobs/{id}/events', {withCredentials:true}) 订阅进度；
4. 提交表单 -> POST /ams/api/jobs；取消 -> POST /ams/api/jobs/{id}/cancel；
5. 断线指数退避重连（≤3 次）-> 降级 2s 轮询 + 每 15s 重试 SSE。

## 已知限制

- 内联样式，未接 DSH 主题 token/组件库；无 HMR。
- 未做 artifacts 列表/下载；TTS 仅占位。
- 业务 Runner 可用性取决于 Gateway 版本（train.rvc 当前未注册）。
