# @ams/plugin-core（Host）

AMS 音乐插件套件的 Host 基础插件（M0.6 最小版）。运行在 DSH Host 进程（Cordis），向 DSH 暴露音乐工具，并向 Client 页面暴露本地 HTTP 桥接路由。

## 依赖

- DSH 运行时提供：@deepseek-ai/dsh-tools（defineTool）、@deepseek-ai/dsh-host-webserver（ctx.webServer）。
- 运行时从环境变量 AMS_HOME 读取 Gateway 位置：
  - AMS_HOME/runtime/ports.json -> gateway.host / gateway.port / gateway.api_prefix
  - AMS_HOME/runtime/gateway.token -> Bearer token

## 注册的工具

| 工具 | 说明 |
|---|---|
| music_ping | 返回插件版本/时间/Gateway 健康（note 可选回显） |
| music_job_submit | 提交 Gateway 任务（type=ping 或 mock.long；seconds 可选）；返回 job id/status |
| music_job_status | 按 job_id 查询 Gateway 任务（status/progress/stage/error） |

工具 schema 使用 DSH 的 value schema DSL（参数与输出均有完整 schema 与 render）。

## 注册的 HTTP 路由（供 Client 页面使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /ams/api/summary | 插件版本 + 已注册工具 + Gateway 健康 + 最近 20 个任务 |
| GET | /ams/api/health | Gateway /health 透传 |
| GET | /ams/api/jobs | Gateway /jobs 透传（limit=50） |
| POST | /ams/api/jobs | Gateway 创建任务透传（body: {type, params?}） |

## 已知限制

- 路由未鉴权（仅 loopback）；M1 改为 DSH Remote/Typert 或加本地 token。
- 任务列表为网关响应顶层 data 数组；分页/筛选未透出。
- 未接 Gateway SSE；页面靠轮询。
