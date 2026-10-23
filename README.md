# ams-plugins（AMS 音乐插件，M1 功能页版）

> **AMS Studio 子项目 · 插件层**  
> 为 AMS Kernel 提供“AMS 音乐工作站”页面、Host 工具桥和本地 Gateway 的鉴权/SSE 连接。它是用户看到的功能页与后端任务系统之间的桥。  
> 总仓库：https://github.com/yan-mc/AMS-Studio


> 阶段：M0.6 最小闭环 → M1 加固（鉴权 + SSE）→ **M1 功能页（四功能 + TTS 占位 + 任务操作）**｜2026-10-19
> 依据：06_方案设计/00_总体设计与约定.md 第 9/10 节、06_方案设计/02_主体/主体详细方案.md、07_执行计划/M0_计划.md
> 目标：在 DSH fork（ams-harness，dsh-v0.2.1-rc.2）+ 本地 Gateway（ams-services/gateway）上提供
> **带鉴权的 Host 工具桥接 + SSE 驱动的多页签音乐工作台**，覆盖音源炼制/人声分离/变声器/歌曲换源与 TTS 占位。

---

## 1. 组件与当前状态

| 组件 | 类型 | 内容 |
|---|---|---|
| @ams/plugin-core 0.3.0 | Host（Cordis 插件） | 5 个模型工具；/ams/api/* 双凭据鉴权；SSE 透传；任务取消 |
| @ams/plugin-ui 0.3.0 | Client（lazy-CJS bundle） | main 整页：5 页签表单 + 任务表（含取消）+ SSE 实时进度 + 鉴权/降级轮询 |
| @ams/music-bundle 0.3.0 | DSH bundle | cordis.patch.yml：insert Host/Client 两行 |
| 工具 | music_ping | 插件/Gateway 健康 |
| 工具 | music_job_submit | 提交任务（ping / mock.long / convert.msvc / convert.rvc / separate.pymss / train.rvc；含路径/模型/音色/变调/F0/训练参数或额外 params） |
| 工具 | music_job_status | 查询单任务状态/进度/阶段/错误 |
| 工具 | music_job_list | 任务列表（status/type/limit 过滤） |
| 工具 | music_job_cancel | 取消任务（queued 立即取消；running -> stopping -> cancelled） |
| 验证 | tools/verify-m0.6.ps1 | 一键验证（构建/安装/鉴权/工具/页签/提交/SSE/取消/页面） |
| 验证 | tools/verify-sse.mjs | 独立鉴权+SSE+取消检查器 |

数据流：
浏览器页面 ->（同源 session cookie）Host 插件 /ams/api/* ->（Bearer gateway token，不出 Host）Gateway /api/v1。

---

## 2. 功能页（Client main 整页，keyed slot ams.home）

| 页签 | Gateway 任务类型 | 表单字段 | 说明 |
|---|---|---|---|
| 音源炼制 | train.rvc | dataset_dir / model / epochs / batch_size / sample_rate | 训练参数按协议透传；Gateway 未注册 train.rvc 时页面显示错误原因 |
| 人声分离 | separate.pymss | input_path / output_dir | GPU 串行队列 |
| 变声器 | convert.rvc | input_path / voice / model / index_path / pitch / f0_method / output_dir | RVC 变声 |
| 歌曲换源 | convert.msvc | input_path / model / voice / output_dir | MSVC 换源 |
| TTS 占位 | —（不提交） | — | M2 接入（内置默认音色曼波），当前仅占位 |

页面能力：

- 页签切换、每页独立表单状态（切页不丢）、提交后自动把它设为 SSE 订阅目标；
- 任务表展示 id/type/status/progress/stage，非终态任务可「取消」；另有 ping 自检与刷新按钮；
- SSE 状态徽标（已连接/重连中/降级轮询）、最近事件、Gateway 任务类型（来自 /health 的 job_types）与工具列表；
- 服务端错误（如 400 UNKNOWN_JOB_TYPE / 502 AMS_GATEWAY_ERROR）原样显示并附提示。

---

## 3. 安全模型（沿用 M1 加固，未降级）

| 调用方 | 凭据 | 获取方式 |
|---|---|---|
| 浏览器页面（同源） | 短时 session（HttpOnly + SameSite=Strict Cookie，30 分钟） | GET /ams/api/session（loopback + 同源校验后签发） |
| 本机 CLI / 启动器 / 验证脚本 | Authorization: Bearer <AMS_HOME/runtime/gateway.token> | 常量时间比较（crypto.timingSafeEqual） |
| 跨站/无凭据 | — | 401；跨站申请 session 403 |

- Gateway token 永不进入浏览器；session 存 Host 进程内存（上限 128，重启失效）；无 CORS 头。
- SSE 同样需要凭据（EventSource 走 cookie），重连时重新校验。

---

## 4. HTTP 接口（ROUTE_PREFIX=/ams/api）

| 方法 | 路径 | 凭据 | 说明 |
|---|---|---|---|
| GET | /session | 无（同源+loopback 门槛） | 签发 HttpOnly session cookie |
| GET | /summary | Bearer/cookie | 插件/工具/auth/鉴权类型 + Gateway 健康 + jobTypes + 最近 20 任务 |
| GET | /health | Bearer/cookie | Gateway /health 透传 |
| GET | /jobs | Bearer/cookie | 任务列表（limit=50） |
| POST | /jobs | Bearer/cookie | 创建任务 {type, params?} |
| GET | /jobs/{id} | Bearer/cookie | 单任务详情 |
| POST | /jobs/{id}/cancel | Bearer/cookie | 取消任务 |
| GET | /jobs/{id}/events | Bearer/cookie | SSE 透传（status/progress/log/artifact，15s keepalive，透传 Last-Event-ID） |

---

## 5. 目录结构

~~~text
ams-plugins/
├─ package.json / pnpm-workspace.yaml / .npmrc
├─ tools/
│  ├─ build.mjs              # src -> lib + lazy-CJS 形状校验 + pnpm pack 到 dist/
│  ├─ verify-m0.6.ps1        # 一键验证（pwsh 7）
│  └─ verify-sse.mjs         # 鉴权/SSE/取消独立检查器
├─ dist/                     # 0.3.0 tarball
└─ packages/
   ├─ plugin-core/           # Host（src/index.js -> lib/index.js）
   ├─ plugin-ui/             # Client（src/client.js -> lib/client.js，lazy-CJS）
   └─ music-bundle/          # cordis.patch.yml（insert 两行）
~~~

---

## 6. 构建与安装

~~~powershell
# Node 24.20 在 WinGet 用户目录；pnpm 11.28.5 随 Node 附带
$env:PATH = 'C:/Users/<user>/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.20.0-win-x64;' + $env:PATH
Set-Location F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-plugins
pnpm install --ignore-scripts   # 无第三方依赖，可选
pnpm run pack                   # = node tools/build.mjs --pack

$env:DSH_HOME = 'F:/Deepseek_harness/AI音乐处理/07_执行计划/_dsh_plugin_home/DSH_HOME'
$env:AMS_HOME = 'F:/Deepseek_harness/AI音乐处理/07_执行计划/_dsh_plugin_home/AMS'
$cli = 'F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-harness/apps/cli/lib/bin.js'
node $cli --profile music --from-default-profile web --dump-default-config
node $cli plugin --profile music add (Get-ChildItem 'F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-plugins/dist/*0.3.0.tgz').FullName
node $cli --profile music --no-open --port 39218
~~~

产物：dist/ams-plugin-core-0.3.0.tgz、ams-plugin-ui-0.3.0.tgz、ams-music-bundle-0.3.0.tgz。
纯 JS（Host ESM + 手写 lazy-CJS），无 TS/tsdown 构建链，可离线构建；pnpm store/cache 指向仓库内或 _dsh_plugin_home，不写用户目录。

---

## 7. 验证（实测 21/21 PASS，2026-10-19T23:18:23+08:00）

~~~powershell
Set-Location F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-plugins
# 必须 pwsh 7（UTF-8 无 BOM + 中文默认路径；WinPS 5.1 会乱码）
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/verify-m0.6.ps1
~~~

| 检查项 | 结果 |
|---|---|
| 构建/打包 0.3.0 tarball、Gateway 端口/token、profile 安装/dump-config、Web 启动 | PASS |
| 无凭据 summary / 跨站 session / 同源 session cookie / cookie 与 Bearer 访问 | PASS（401 / 403 / 200+HttpOnly+SameSite / 200） |
| 工具注册 5 个 | PASS：music_ping,music_job_submit,music_job_status,music_job_list,music_job_cancel |
| Gateway 任务类型透出 | PASS：convert.msvc,convert.rvc,mock.long,ping,separate.pymss |
| convert.rvc 提交链路 | PASS：HTTP 201（Gateway 已注册 Runner；未注册时 502 AMS_GATEWAY_ERROR 透传） |
| SSE 事件 + 取消流 | PASS：11 事件 terminal=succeeded；mock.long 取消后 cancelled；无凭据 SSE=401 |
| 页签 | PASS：音源炼制/人声分离/变声器/歌曲换源/TTS 占位全部进入下发 bundle |
| 页面可加载（boot graph + bundle） | PASS：含 @ams/plugin-ui，bundle 1,947,507 B 含 EventSource/session |

结构化证据：07_执行计划/_dsh_plugin_home/M1-验证结果.json；日志：logs/verify-*。

---

## 8. Client 行为（plugin-ui）

1. 挂载后 GET /ams/api/session -> GET /ams/api/summary；401 自动重申请 session 后重试；
2. 选 active job（running/queued/stopping）作为 watched；EventSource('/ams/api/jobs/{id}/events', {withCredentials:true})；
3. progress/status 事件就地更新任务行；artifact/log 更新最近事件；终态关闭 SSE 并刷新；
4. 提交表单 -> POST /ams/api/jobs（参数按类型透传）；成功后把新 job 设为 watched；错误信息原样展示；
5. 取消按钮 -> POST /ams/api/jobs/{id}/cancel；SSE 随后推送 stopping/cancelled；
6. 断线：指数退避重连（≤3 次）-> 降级 2s 轮询 + 每 15s 试重连；页面显示 SSE 状态。

---

## 9. 已知限制（M1）

1. Gateway Runner 覆盖率取决于 Gateway 版本：本轮实测 Gateway 暴露 convert.msvc/convert.rvc/separate.pymss/mock.long/ping，train.rvc 未注册（音源炼制提交会返回错误并显示原因）。
2. Host session 存进程内存，重启失效；未做撤销 UI/审计落盘；Electron dsh-app:// 源未验证。
3. 页面用内联样式，未接 DSH 主题 token/组件库；无 HMR；未做 DOM 级断言（用 boot graph + bundle + 接口闭环验证）。
4. SSE 无逐事件背压；长任务大量 log 由 Gateway 保留策略约束。
5. 未接 DSH Remote/Typert；/ams/api 仍是裸 HTTP；未做插件签名/哈希。

---

## 10. 下一步（M2）

1. DSH ctx.remote（Typert）替换裸 HTTP，鉴权收敛到连接层；
2. 业务 Runner 全部接入后补 train.rvc 页面联调与 artifacts 下载；
3. 启动器（Tauri/Electron）联调同源策略，补 dsh-app:// 场景；
4. TS 化 + 官方 clientBundle preset；session 撤销/审计。
