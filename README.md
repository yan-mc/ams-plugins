# ams-plugins（AMS 音乐插件，M0.6 最小闭环）

> 阶段：**M0.6 DSH 音乐插件最小闭环（已完成）**｜2026-10-19
> 依据：06_方案设计/00_总体设计与约定.md 第 9/10 节、06_方案设计/02_主体/主体详细方案.md、07_执行计划/M0_计划.md M0.6
> 目标：在 DSH fork（ams-harness，dsh-v0.2.1-rc.2）+ 本地 Gateway（ams-services/gateway）上跑通 Host 工具、Client 整页与 Gateway 任务闭环。

---

## 1. 当前已实现（M0.6）

| 组件 | 类型 | 内容 | 状态 |
|---|---|---|---|
| @ams/plugin-core | Host（Cordis 插件） | 注册 3 个模型工具；注册 /ams/api/* 本地桥接路由（转发 Gateway）；从 AMS_HOME/runtime 读取端口与 Bearer token | 已实测加载 |
| @ams/plugin-ui | Client（lazy-CJS bundle） | main keyed slot 整页（Gateway 健康/工具列表/任务列表/创建 ping 按钮/1s 轮询）+ sidebar.panellist 入口 | 已实测加载（boot graph + bundle 200） |
| @ams/music-bundle | DSH bundle | cordis.patch.yml：insert 上述 Host/Client 两行 | 已安装到 profile |
| 工具 | music_ping | 返回插件版本/时间/Gateway 健康 | 已注册（summary 可见） |
| 工具 | music_job_submit | 调 Gateway POST /api/v1/jobs（ping / mock.long），返回 job id | 已注册 |
| 工具 | music_job_status | 调 Gateway GET /jobs/{id} | 已注册 |

数据流：Client 页面 ->（同源 fetch）/ams/api/* -> Host 插件 @ams/plugin-core ->（Bearer token）127.0.0.1:<port>/api/v1 -> ams-gateway（SQLite 任务）。

---

## 2. 目录结构

~~~text
ams-plugins/
├─ package.json                  # pnpm workspace 根（脚本：build / pack / clean / verify）
├─ pnpm-workspace.yaml           # packages/*；storeDir/cacheDir 指向仓库内（避免写用户目录）
├─ .npmrc                        # auto-install-peers=false
├─ tools/
│  ├─ build.mjs                  # 构建：src -> lib（校验 lazy-CJS 形状）+ pnpm pack 到 dist/
│  └─ verify-m0.6.ps1            # 一键验证脚本（隔离 DSH_HOME + Gateway + 安装 + 启动 + 断言）
├─ dist/                         # 可安装 tarball（pnpm pack 产物）
└─ packages/
   ├─ plugin-core/               # Host：tools + /ams/api 路由
   │  ├─ src/index.js
   │  ├─ lib/index.js            # build 产物
   │  └─ package.json
   ├─ plugin-ui/                 # Client：整页 + 侧栏入口
   │  ├─ src/client.js           # lazy-CJS：window.__ModuleLoader__.load({ id, factory })
   │  ├─ src/index.js            # Node 半侧空 apply
   │  ├─ lib/client.js           # build 产物（DSH 只加载 lib，不加载 src）
   │  └─ package.json            # dsh.client.platform=web
   └─ music-bundle/              # DSH 组合包（dsh.bundle.patch）
      ├─ cordis.patch.yml
      └─ package.json
~~~

---

## 3. 环境要求（M0.6 实测环境）

| 项 | 版本/路径 | 说明 |
|---|---|---|
| Node.js | 24.20.0 | WinGet 用户级安装：C:/Users/<user>/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_*/node-v24.20.0-win-x64 |
| pnpm | 11.28.5 | 随 Node 目录内的 pnpm 垫片（无需全局安装） |
| DSH fork | 08_项目代码/ams-harness，tag dsh-v0.2.1-rc.2（0.2.1-rc.2），已 pnpm run build | 用 apps/cli/lib/bin.js 启动 |
| Gateway | 08_项目代码/ams-services/gateway（.venv，pytest 23 passed） | 用 .venv/Scripts/python.exe -m app 启动 |
| 平台 | Windows 11 x64 | M0.6 只验证 Windows |

> 注意：本机 DSH 进程的环境变量可能早于 Node 安装，导致 node 不在 PATH。验证脚本会把 Node 目录前置到 PATH（见 tools/verify-m0.6.ps1）。

---

## 4. 构建

~~~powershell
# Node 目录加入 PATH（示例，按本机实际路径调整）
$env:PATH = 'C:/Users/<user>/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.20.0-win-x64;' + $env:PATH
Set-Location F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-plugins

pnpm install --ignore-scripts   # 无第三方依赖；仅建立 workspace 链接（可选）
pnpm run pack                   # = node tools/build.mjs --pack
~~~

产物：

~~~text
dist/ams-plugin-core-0.1.2.tgz
dist/ams-plugin-ui-0.1.2.tgz
dist/ams-music-bundle-0.1.2.tgz
~~~

说明：

- 两个插件包在 M0.6 是纯 JS（Host 为 ESM；Client 为手写 lazy-CJS bundle），没有 TS/tsdown 构建链，build 只做 src->lib 复制与形状校验，因此可离线构建。
- Client bundle 必须是 window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {...; return module.exports } }) 形状；DSH 只加载 lib/client.js。
- 不写用户目录/全局 pnpm 状态：workspace 与 test profile 的 pnpm store/cache 都指向本仓库或 07_执行计划/_dsh_plugin_home 内。

---

## 5. 安装到隔离 DSH_HOME（实测步骤）

以隔离 home 07_执行计划/_dsh_plugin_home 为例（不污染真实 %LOCALAPPDATA%/AMS 与用户 DSH 数据）：

~~~powershell
$env:DSH_HOME = 'F:/Deepseek_harness/AI音乐处理/07_执行计划/_dsh_plugin_home/DSH_HOME'
$env:AMS_HOME = 'F:/Deepseek_harness/AI音乐处理/07_执行计划/_dsh_plugin_home/AMS'
$cli = 'F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-harness/apps/cli/lib/bin.js'

# 1) 初始化 music profile（基于 web 模板：base + web-app）
node $cli --profile music --from-default-profile web --dump-default-config

# 2) 安装 3 个 tarball（dsh plugin = pnpm；--profile music）
node $cli plugin --profile music add (Get-ChildItem 'F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-plugins/dist/*0.1.2.tgz').FullName

# 3) 校验组合行
node $cli --profile music --dump-config | Select-String 'ams-plugin-core|ams-plugin-ui|music-bundle'

# 4) 启动 Web（隔离 home + 固定端口）
node $cli --profile music --no-open --port 39218
~~~

- 也可以用官方插件安装方式（dsh plugin --profile <name> add <spec>）；本 M0.6 用本地 tarball，离线可装。
- music profile 的 pnpm storeDir/cacheDir 已在验证中写入 profile 的 pnpm-workspace.yaml，避免写到盘根/用户目录。

---

## 6. 一键验证（tools/verify-m0.6.ps1）

~~~powershell
Set-Location F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-plugins
# 必须用 PowerShell 7（pwsh）运行：脚本为 UTF-8 无 BOM 且默认参数含中文路径，
# Windows PowerShell 5.1 会按 ANSI 解码导致路径乱码。
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/verify-m0.6.ps1
~~~

> 实测：pwsh 7 下 12/12 PASS；Windows PowerShell 5.1 因编码问题失败（已记录）。

脚本步骤（可重复执行）：

1. 起 Gateway（隔离 AMS_HOME；动态端口写入 runtime/ports.json）；
2. 初始化/复用隔离 DSH_HOME 的 music profile；
3. 安装 dist 最新 tarball（dsh plugin add）；
4. 启动 dsh --profile music --no-open --port 39218；
5. 带 token 访问首页（200），断言：
   - GET /ams/api/summary：tools 包含 3 个工具、gateway.ok=true；
   - POST /ams/api/jobs {type:ping}：创建成功，轮询至 succeeded/progress=100；
   - 首页 HTML 含 __DSH_BOOT__ 与 @ams/plugin-ui；
   - 对应 boot combo URL 返回 200 且包含 @ams/plugin-ui / 页面代码；
6. 输出 PASS/FAIL 与证据文件路径（07_执行计划/_dsh_plugin_home/logs/）。

---

## 7. 实测结果（2026-10-19 22:0x，本机）

| 检查项 | 结果 | 证据 |
|---|---|---|
| profile 初始化（music from web） | PASS | _dsh_plugin_home/logs/dsh-profile-init-2.log |
| 安装 3 包（0.1.2） | PASS | _dsh_plugin_home/logs/dsh-plugin-add-012.log |
| dump-config 含 Host/Client 行 | PASS | _dsh_plugin_home/logs/dsh-dump-config-2.log |
| Web 启动 + token URL + 首页 200 | PASS（0 错误行） | _dsh_plugin_home/logs/dsh-web-3.out.log / dsh-web-3.err.log |
| Host 工具注册 | PASS：music_ping / music_job_submit / music_job_status | GET /ams/api/summary；_dsh_plugin_home/logs/ams-summary-3.json |
| Gateway 桥接 | PASS：gateway.ok=true，version=0.1.0 | 同上 |
| 通过页面同源接口创建任务并完成 | PASS：job_3293c005335c4e7f -> succeeded（脚本复跑）；手工验证 job_391c3ecf75fc4adf -> succeeded progress=100 stage=done | _dsh_plugin_home/logs/verify-final-job.json、ams-final-job-3.json |
| Client 进入 boot graph | PASS：@ams/plugin-ui 在 preload combo 中 | _dsh_plugin_home/logs/boot-graph-href.txt |
| Client bundle 实际下发 | PASS：HTTP 200，1,926,251 bytes，含 id/页面/侧栏注册代码 | _dsh_plugin_home/logs/served-client-combo.js |

结构化证据：07_执行计划/_dsh_plugin_home/M0.6-验证结果.json（脚本 12/12 PASS，2026-10-19T22:21:46+08:00）；手工详细证据：M0.6-验证结果-手工详细.json。

---

## 8. 限制（M0.6 已知，不阻塞 M1）

1. 桥接路由未鉴权：/ams/api/* 目前只靠 127.0.0.1 回环 + 无 token；M1 需改走 DSH Remote（Typert）或加本地 token。
2. 无 SSE：页面每 1s 轮询 summary；任务进度通过 Gateway 列表接口取，未接 Gateway SSE。
3. 纯 JS 实现：无 TS 类型、无 tsdown/客户端构建 preset、无 HMR；与 06 方案的自建构建链目标还有差距（见主体详细方案 §6.8）。
4. 无工具执行实测：工具注册已验证（defineTool 校验通过 + summary 可见），但未通过真实 LLM 调用 execute（按任务要求无需 LLM）。
5. 页面渲染验证方式：boot graph + bundle 下发 + Host 接口闭环；未做浏览器 DOM 断言（无 headless 浏览器依赖）。
6. mock 任务：仅 ping；mock.long 未在本轮验证（Gateway 已有测试覆盖）。
7. 安装走 file: tarball + 本地 pnpm store；正式分发需要签名/哈希校验（ams-release 清单）。

---

## 9. 下一步（M1 建议）

1. 用 DSH ctx.remote（Typert codegen）替换 /ams/api 裸路由，鉴权与类型化；
2. 接 Gateway SSE -> DSH jobs 镜像（music_job_* 与任务页统一）；
3. 把 plugin-ui 迁移为 TS + 官方 clientBundle 构建 preset（或复刻版）；
4. 增加 settings.section（Gateway URL/token 配置）与错误态；
5. 补 mock.long 进度/取消的页面联调；
6. 插件签名/哈希 + profile 安装的 allowlist（ams-release）。
