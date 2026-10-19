# ams-plugins（AMS 音乐插件，M1 加固版）

> 阶段：**M0.6 最小闭环已跑通 → M1 插件加固（鉴权 + SSE）**｜2026-10-19
> 依据：06_方案设计/00_总体设计与约定.md 第 9/10 节、06_方案设计/02_主体/主体详细方案.md、07_执行计划/M0_计划.md
> 目标：在 DSH fork（ams-harness，dsh-v0.2.1-rc.2）+ 本地 Gateway（ams-services/gateway）上，
> 提供带鉴权的 Host 工具桥接与 SSE 驱动的 Client 整页，替代 M0.6 的裸路由 + 1s 轮询。

---

## 1. 组件与当前状态

| 组件 | 类型 | 内容 |
|---|---|---|
| @ams/plugin-core | Host（Cordis 插件） | 3 个模型工具；/ams/api/* 鉴权桥接路由；/ams/api/jobs/{id}/events SSE 透传；Bearer/session 双凭据；常量时间比较 |
| @ams/plugin-ui | Client（lazy-CJS bundle） | main 整页（状态/工具/任务表/SSE 状态）+ sidebar 入口；启动时申请同源 session cookie；EventSource 订阅任务进度，断线重连 + 降级 2s 轮询 |
| @ams/music-bundle | DSH bundle | cordis.patch.yml：insert Host/Client 两行 |
| 工具 | music_ping | 插件/Gateway 健康 |
| 工具 | music_job_submit | 提交 Gateway 任务（ping / mock.long），返回 job id |
| 工具 | music_job_status | 查询 Gateway 任务 |
| 验证 | tools/verify-m0.6.ps1 | 一键验证（构建/安装/鉴权/SSE/页面），产出 M1-验证结果.json |
| 验证 | tools/verify-sse.mjs | 独立 SSE/鉴权检查器（Node，被 ps1 调用） |

数据流：
浏览器页面 ->（同源 cookie）/ams/api/* -> Host 插件（鉴权 + 常量时间校验）->（Bearer gateway token，不出 Host）127.0.0.1:<port>/api/v1 -> ams-gateway。

---

## 2. 安全模型（M1 核心变更）

| 调用方 | 凭据 | 获取方式 | 适用接口 |
|---|---|---|---|
| 浏览器页面（同源） | 短时 session（HttpOnly Cookie） | GET /ams/api/session（同源 + loopback 校验后签发） | 全部 /ams/api/*（含 SSE） |
| 本机 CLI / 启动器 / 验证脚本 | Authorization: Bearer <gateway token> | 读 AMS_HOME/runtime/gateway.token | 全部 /ams/api/*（含 SSE） |
| 其他/跨站 | 无 | — | 401（session 签发跨站为 403） |

关键设计：

1. Gateway token 永不进入浏览器：页面只拿到 Host 签发的一次性 session id（随机 32 字节，base64url）。
2. session cookie 属性：HttpOnly + SameSite=Strict + Path=/ams/api + Max-Age=1800；token 存在 Host 进程内存 Map（TTL 30 分钟，上限 128，惰性清理），Host 重启即全部失效。
3. 签发门槛：Host 头必须是 loopback（127.0.0.1 / localhost / [::1]）——防 DNS rebinding；Origin/Referer 必须与 Host 同源；Sec-Fetch-Site 只接受 same-origin/none；否则 403。
4. 校验：所有 /ams/api/*（除 /session）先尝试 Bearer（对 runtime/gateway.token 做 crypto.timingSafeEqual 常量时间比较），再尝试 session cookie；都失败返回 401 + WWW-Authenticate。长度不等也执行一次等长 dummy 比较，避免长度侧信道提前返回。
5. SSE 鉴权：EventSource 无法自定义 Header，因此必须走 cookie；SSE 连接建立时同样执行上述校验，且每次重连都重新校验。
6. 不设 CORS 头：跨站脚本无法读取响应；SameSite=Strict 阻断跨站携带 cookie。
7. 未覆盖（M2）：Host 进程内 session 不做跨重启持久化；Electron 自定义协议（dsh-app://）下的 Origin 语义需在启动器联调时验证；未做请求限流/审计日志落盘。

---

## 3. HTTP 接口（全部挂 ROUTE_PREFIX=/ams/api）

| 方法 | 路径 | 凭据 | 说明 |
|---|---|---|---|
| GET | /session | 无（同源 + loopback 门槛） | 签发 HttpOnly session cookie；返回 {ok,auth,expiresInSec} |
| GET | /summary | Bearer 或 cookie | 插件/工具/鉴权类型 + Gateway 健康 + 最近 20 任务 + auth 字段 |
| GET | /health | Bearer 或 cookie | Gateway /health 透传 |
| GET | /jobs | Bearer 或 cookie | Gateway /jobs 透传（limit=50） |
| POST | /jobs | Bearer 或 cookie | 创建任务 {type, params?}（201） |
| GET | /jobs/{id} | Bearer 或 cookie | 单任务详情 |
| GET | /jobs/{id}/events | Bearer 或 cookie | SSE 透传 Gateway 事件（status/progress/log/artifact），带 keepalive 心跳与 Last-Event-ID 透传 |

错误统一 {ok:false, error:{code, message}}；401 带 WWW-Authenticate: Bearer realm="ams"。

---

## 4. 目录结构

~~~text
ams-plugins/
├─ package.json / pnpm-workspace.yaml / .npmrc
├─ tools/
│  ├─ build.mjs              # src -> lib + 校验 lazy-CJS + pnpm pack 到 dist/
│  ├─ verify-m0.6.ps1        # 一键验证（pwsh 7）：构建/安装/鉴权/SSE/页面
│  └─ verify-sse.mjs         # SSE + 鉴权独立检查器
├─ dist/                     # tarball（0.2.0 可装）
└─ packages/
   ├─ plugin-core/           # src/index.js -> lib/index.js（Host）
   ├─ plugin-ui/             # src/client.js -> lib/client.js（Client，lazy-CJS）
   └─ music-bundle/          # cordis.patch.yml（insert 两行）
~~~

---

## 5. 构建

~~~powershell
# Node 24.20 在 WinGet 用户目录；pnpm 11.28.5 随 Node 附带
$env:PATH = 'C:/Users/<user>/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.20.0-win-x64;' + $env:PATH
Set-Location F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-plugins

pnpm install --ignore-scripts   # 无第三方依赖，可选
pnpm run pack                   # = node tools/build.mjs --pack
~~~

产物：dist/ams-plugin-core-0.2.0.tgz、ams-plugin-ui-0.2.0.tgz、ams-music-bundle-0.2.0.tgz。
纯 JS（Host ESM + 手写 lazy-CJS），无 TS/tsdown 构建链，可离线构建；pnpm store/cache 指向仓库内或 07_执行计划/_dsh_plugin_home，不写用户目录。

---

## 6. 安装到隔离 DSH_HOME

~~~powershell
$env:DSH_HOME = 'F:/Deepseek_harness/AI音乐处理/07_执行计划/_dsh_plugin_home/DSH_HOME'
$env:AMS_HOME = 'F:/Deepseek_harness/AI音乐处理/07_执行计划/_dsh_plugin_home/AMS'
$cli = 'F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-harness/apps/cli/lib/bin.js'

node $cli --profile music --from-default-profile web --dump-default-config
node $cli plugin --profile music add (Get-ChildItem 'F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-plugins/dist/*0.2.0.tgz').FullName
node $cli --profile music --no-open --port 39218
~~~

profile 的 pnpm storeDir/cacheDir 已被验证脚本写入 profile 的 pnpm-workspace.yaml，避免写到盘根。

---

## 7. 验证（M1，实测 17/17 PASS）

~~~powershell
Set-Location F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-plugins
# 必须 pwsh 7（脚本 UTF-8 无 BOM 且默认参数含中文路径）；WinPS 5.1 会乱码
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/verify-m0.6.ps1
~~~

覆盖项与实测结果（2026-10-19T22:37:42+08:00，profile=music，隔离 DSH_HOME）：

| 检查项 | 结果 |
|---|---|
| 构建/打包 3 个 0.2.0 tarball | PASS |
| Gateway ports.json + token | PASS（动态端口 12084） |
| profile 初始化 / 插件安装 / dump-config 含两行 | PASS |
| Web 启动 + token URL + 首页 200 | PASS |
| 无凭据访问 /ams/api/summary | PASS：HTTP 401 |
| 跨站申请 session | PASS：HTTP 403 |
| 同源申请 session | PASS：HTTP 200 + 1 cookie（HttpOnly、SameSite=Strict） |
| 带 cookie 访问 summary | PASS：HTTP 200，auth=session，tools=3 |
| 带 Bearer 访问 summary | PASS：HTTP 200，auth=bearer |
| SSE 鉴权拒绝 | PASS：无凭据 events 接口 401 |
| SSE 透传事件 | PASS：11 个事件（status/log/progress/artifact），terminal=succeeded |
| 页面仍可加载（boot graph 含 @ams/plugin-ui） | PASS |
| Client bundle（1,936,961 B）含 EventSource + session bootstrap | PASS |
| 首页 200 | PASS |

结构化证据：07_执行计划/_dsh_plugin_home/M1-验证结果.json；日志：07_执行计划/_dsh_plugin_home/logs/（verify-*、m1-*）。

---

## 8. Client 行为（plugin-ui）

1. 页面挂载 -> GET /ams/api/session（同源）-> 再拉 /ams/api/summary；
2. summary 返回后选一个 active job（running/queued/stopping）作为 watched，创建 EventSource('/ams/api/jobs/{id}/events', {withCredentials:true})；
3. 事件处理：progress/status -> 就地更新任务行（progress/stage/status）；artifact/log 更新最近事件展示；status 进入终态则关闭 ES 并刷新列表；
4. 断线：onerror 关闭并指数退避重连（400ms*2^n，上限 8s，最多 3 次）；仍失败 -> fallback 模式每 2s 轮询 summary，每 15s 尝试重连 SSE；
5. 401：fetchJson 自动重新申请 session 后重试一次；
6. 页面显示：Host 插件版本、页面鉴权类型、SSE 状态（已连接/重连中/降级轮询）、最近事件、Gateway 健康、工具列表、任务表、创建 ping 按钮。

---

## 9. 限制（M1 已知，不阻塞下一阶段）

1. Host 进程内存 session：Host 重启即失效（页面会自动重申请）；不做跨进程/跨启动器持久化。
2. 仅同源 Web 验证：Electron 自定义协议（dsh-app://）下 Origin/Sec-Fetch-Site 行为未验证，启动器联调时需单独处理（必要时允许 dsh-app:// 源或改走 DSH Remote）。
3. SSE 未做逐事件背压/限流；长任务大量 log 事件由 Gateway 侧保留策略约束。
4. 浏览器只做 boot graph + bundle + 接口闭环验证，未引入 headless 浏览器做 DOM 断言。
5. 未接 DSH Remote/Typert（M2），/ams/api 仍是裸 HTTP；未做插件签名/哈希。
6. mock.long 的 SSE 未在本轮脚本验证（Gateway 测试覆盖；脚本只跑 ping）。

---

## 10. 下一步（M2 建议）

1. 用 DSH ctx.remote（Typert codegen）替代裸 /ams/api，把鉴权收敛到 DSH 连接层；
2. 启动器（Tauri/Electron 壳）联调同源策略，补 dsh-app:// 场景；
3. Host session 改为可撤销（登出/过期清理 UI）+ 审计日志落盘；
4. TS 化 + 官方 clientBundle 构建 preset；
5. 任务页接 Gateway artifacts 列表/下载；mock.long 进度/取消联调。
