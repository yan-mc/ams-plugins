# @ams/plugin-ui（Client，M1 加固）

AMS 音乐插件套件的浏览器侧插件，以 DSH lazy-CJS bundle 加载（lib/client.js：window.__ModuleLoader__.load）。

## 注册内容

| 槽位 | 内容 |
|---|---|
| main（keyed：ams.home） | 整页：Host 插件/页面鉴权类型/SSE 状态/最近事件/Gateway 健康/工具列表、任务表（状态/进度/阶段）、创建 ping 按钮 |
| sidebar.panellist（list，id=ams.home，order=10） | 侧栏入口「AMS 音乐」+ 音符图标 |

## 数据与鉴权

1. 页面挂载先 GET /ams/api/session（同源）建立 HttpOnly session cookie（Gateway token 不进入浏览器）；
2. GET /ams/api/summary 取状态/任务列表；遇到 401 自动重新申请 session 并重试一次；
3. 选中 active job 后用 EventSource('/ams/api/jobs/{id}/events', {withCredentials:true}) 订阅进度；
4. progress/status 事件就地更新任务行；终态到达关闭 SSE 并刷新列表；
5. 断线：指数退避重连（最多 3 次），失败后降级 2s 轮询 summary，并每 15s 尝试重连 SSE。

## 环境要求

- 平台模块 react（DSH PLATFORM_MODULES 提供），无需自带依赖。
- 包清单：dsh.client = { platform: 'web', inject: [...] }；exports["./client"] -> ./lib/client.js。

## 已知限制

- 进程内 session 重启失效（页面自动重申请）。
- 内联样式，未接 DSH 主题 token/组件库；无 HMR。
- 未做 artifacts 下载；mock.long 仅展示进度/终态。
