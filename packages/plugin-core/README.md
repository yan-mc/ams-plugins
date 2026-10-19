# @ams/plugin-core（Host，M1 功能页版）

AMS 音乐插件套件的 Host 基础插件。运行在 DSH Host 进程（Cordis），向 DSH 暴露音乐工具，并向 Client 页面暴露带鉴权的桥接路由、SSE 透传与任务操作。

## 依赖与数据源

- DSH 运行时：@deepseek-ai/dsh-tools、@deepseek-ai/dsh-host-webserver。
- 环境变量 AMS_HOME：runtime/ports.json（Gateway 地址/端口）+ runtime/gateway.token（Bearer）。

## 鉴权模型

| 调用方 | 凭据 |
|---|---|
| 本机 CLI / 启动器 / 验证脚本 | Authorization: Bearer <gateway token>（常量时间比较） |
| 浏览器页面（同源） | GET /ams/api/session 签发的 HttpOnly + SameSite=Strict session cookie（30 分钟，内存 Map，≤128） |
| 跨站/无凭据 | 401；跨站申请 session 403 |

签发门槛：Host 头 loopback（防 DNS rebinding）+ Origin/Referer 同源 + Sec-Fetch-Site 仅 same-origin/none。

## 工具（5 个）

| 工具 | 说明 |
|---|---|
| music_ping | 插件版本/时间/Gateway 健康 |
| music_job_submit | 提交任务：ping / mock.long / convert.msvc / convert.rvc / separate.pymss / train.rvc；支持 input_path、output_dir、model、voice、index_path、dataset_dir、pitch、f0_method、epochs、batch_size、sample_rate、seconds 或 params(JSON) |
| music_job_status | 单任务状态/进度/阶段/错误 |
| music_job_list | 列表（status/type/limit 过滤） |
| music_job_cancel | 取消任务（queued 立即；running->stopping->cancelled） |

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /ams/api/session | 签发 session cookie（唯一无凭据接口，受同源/loopback 门槛） |
| GET | /ams/api/summary | 插件/auth/工具 + Gateway 健康 + jobTypes + 最近 20 任务 |
| GET | /ams/api/health | Gateway /health 透传 |
| GET | /ams/api/jobs | Gateway /jobs 透传 |
| POST | /ams/api/jobs | 创建任务（201） |
| GET | /ams/api/jobs/{id} | 单任务详情 |
| POST | /ams/api/jobs/{id}/cancel | 取消任务 |
| GET | /ams/api/jobs/{id}/events | SSE 透传（status/progress/log/artifact；15s keepalive；Last-Event-ID） |

Gateway 错误统一包装为 502 {code: AMS_GATEWAY_ERROR, message 含上游状态码与原因}，便于页面展示（如 UNKNOWN_JOB_TYPE）。

## 已知限制

- session 存 Host 进程内存，重启失效；未做撤销 UI/审计落盘。
- 未接 DSH Remote/Typert（M2）；Electron dsh-app:// Origin 语义未验证。
- SSE 无背压/限流；工具参数未做每类型强校验（由 Gateway Runner 校验）。
