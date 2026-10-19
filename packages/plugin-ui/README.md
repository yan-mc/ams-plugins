# @ams/plugin-ui（Client）

AMS 音乐插件套件的浏览器侧插件（M0.6 最小版）。以 DSH lazy-CJS bundle 形式加载（lib/client.js：window.__ModuleLoader__.load）。

## 注册内容

| 槽位 | 内容 |
|---|---|
| main（keyed：ams.home） | 整页：运行状态（Host 插件/Gateway/工具列表）、任务表（id/type/status/progress/stage）、创建 ping 任务按钮、1s 轮询 |
| sidebar.panellist（list，id=ams.home，order=10） | 侧栏入口「AMS 音乐」+ 音符图标；点击由 DSH 侧栏切换到 ams.home 页面 |

数据来自 Host 插件 @ams/plugin-core 的同源桥接路由 /ams/api/summary 与 /ams/api/jobs（不直接访问 Gateway，token 不进入浏览器）。

## 环境要求

- 平台模块：react（DSH PLATFORM_MODULES 提供），无需自带依赖。
- 包清单：dsh.client = { platform: 'web', inject: [...] }；exports["./client"] -> ./lib/client.js。

## 已知限制

- 未使用 DSH Remote/SSE；1s 轮询。
- 内联样式（M0.6），未接 DSH 主题 token/组件库。
- 无 HMR（Electron 客户端插件需重启）。
