# @ams/plugin-core（Host，M1 加固）

AMS 音乐插件套件的 Host 基础插件。运行在 DSH Host 进程（Cordis），向 DSH 暴露音乐工具，并向 Client 页面暴露**带鉴权**的本地 HTTP 桥接路由与 SSE 透传。

## 依赖

- DSH 运行时提供：@deepseek-ai/dsh-tools（defineTool）、@deepseek-ai/dsh-host-webserver（ctx.webServer）。
- 运行时从环境变量 AMS_HOME 读取 Gateway 位置与凭据：
  - AMS_HOME/runtime/ports.json -> gateway.host / gateway.port / gateway.api_prefix
  - AMS_HOME/runtime/gateway.token -> Bearer token（只在 Host 内使用，不下发浏览器）

## 鉴权模型（M1）

| 调用方 | 凭据 |
|---|---|
| 本机 CLI / 启动器 / 验证脚本 | Authorization: Bearer <gateway token>（crypto.timingSafeEqual 常量时间比较） |
| 浏览器页面（同源） | GET /ams/api/session 签发的 HttpOnly + SameSite=Strict session cookie（30 分钟，内存 Map，最多 128 个） |
| 其他/跨站 | 401；跨站申请 session 403 |

- 签发门槛：Host 头必须为 loopback（防 DNS rebinding）、Origin/Referer 与 Host 同源、Sec-Fetch-Site 仅 same-origin/none。
- 除 /session 外的全部 /ams/api/* 均先 Bearer 后 session 校验；失败 401 + WWW-Authenticate。
- 无 CORS 头；Gateway token 永不出 Host。

## 注册的工具

| 工具 | 说明 |
|---|---|
| music_ping | 插件版本/时间/Gateway 健康 |
| music_job_submit | 提交 Gateway 任务（ping / mock.long，seconds 可选） |
| music_job_status | 按 job_id 查询状态/进度/阶段/错误 |

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /ams/api/session | 签发 session cookie（唯一无凭据接口，受同源/loopback 门槛保护） |
| GET | /ams/api/summary | 插件版本 + auth 类型 + 工具 + Gateway 健康 + 最近 20 任务 |
| GET | /ams/api/health | Gateway /health 透传 |
| GET | /ams/api/jobs | Gateway /jobs 透传（limit=50） |
| POST | /ams/api/jobs | 创建任务（201） |
| GET | /ams/api/jobs/{id} | 单任务详情 |
| GET | /ams/api/jobs/{id}/events | SSE 透传（status/progress/log/artifact），15s keepalive 心跳，透传 Last-Event-ID |

## 已知限制

- session 存于 Host 进程内存，重启即全部失效；未做撤销 UI/审计落盘。
- 未接 DSH Remote/Typert（M2），/ams/api 仍是裸 HTTP。
- Electron 自定义协议（dsh-app://）的 Origin 语义未验证。
- SSE 未做背压/限流。
