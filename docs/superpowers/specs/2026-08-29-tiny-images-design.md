# tiny-images 设计文档

日期：2026-08-29
状态：已确认（用户已批准设计方向）

## 1. 背景与目标

tiny-images 是一个生图 API 网关：聚合多个上游生图渠道（OpenAI 官方、各类 OpenAI 兼容中转站），对外统一暴露 ChatGPT/OpenAI images API 格式（`/v1/images/generations`、`/v1/images/edits`、`/v1/models`），使任何 OpenAI SDK 客户端只需改 baseURL 即可使用。

配套能力：

- Web Playground：快速选 model、试 prompt、看出图效果与命中渠道。
- 管理后台：可视化维护渠道、key 池、model 映射、对外 API key，查看请求日志。
- Docker 一键部署（最后阶段实现）。

### 非目标（第一版不做）

- 非 OpenAI 兼容上游（如原生豆包/Replicate 协议）——Provider 接口预留扩展点，但不实现。
- 竞速路由、按渠道计费/配额统计、多用户体系。
- 图片编辑之外的其他模态（音频、视频）。

## 2. 总体架构

单进程单体，一个 Fastify 服务同时承载 API 与 Web 静态资源。

```
tiny-images/
├─ src/                     # 后端 (Node.js + TypeScript + Fastify)
│  ├─ server/
│  │  ├─ http/              # 路由层：/v1、/admin、/files、/health、静态托管
│  │  ├─ auth.ts            # Bearer 鉴权（API key / admin token）
│  │  └─ index.ts           # 入口：装配、启动
│  ├─ core/
│  │  ├─ router.ts          # model → 渠道映射
│  │  ├─ keyPool.ts         # 渠道内 apiKey 轮询 + 冷却
│  │  ├─ executor.ts        # 编排：解析请求 → 路由 → 调 Provider → 转换响应 → 日志
│  │  └─ errors.ts          # OpenAI 错误格式映射
│  ├─ providers/
│  │  ├─ types.ts           # Provider 接口与统一请求/结果模型
│  │  └─ openai-compat.ts   # OpenAI 兼容 Provider（官方 + 中转站）
│  ├─ store/
│  │  ├─ db.ts              # better-sqlite3 初始化、迁移
│  │  └─ repo.ts            # channels/keys/models/api_keys/logs 数据访问
│  └─ media/
│     └─ b64cache.ts        # b64↔url 转换（落盘 /data/generated + TTL 清理）
├─ web/                     # 前端 (React 18 + Vite + TypeScript)
│  └─ src/
│     ├─ pages/Playground   # 调试页
│     ├─ pages/Admin        # 管理后台（渠道/映射/key/日志）
│     └─ pages/Login        # admin token 登录
├─ data/                    # 运行时目录（SQLite、生成图缓存、可选 config.yaml 种子）
├─ Dockerfile               # 多阶段构建（最后阶段）
└─ docker-compose.yml       # volume /data、env 注入（最后阶段）
```

数据流（generations 为例）：

```
客户端 --Bearer key--> /v1/images/generations
  → auth 校验（api_keys 表）
  → 参数校验 → 统一请求模型
  → router 按 model 查映射 → 得到渠道 + 上游 model 名
  → keyPool 取一个可用 key
  → OpenAICompatProvider.generate() 发上游请求
  → 失败且可换 key（401/429）→ 换 key 重试（上限=该渠道启用 key 数）
  → 成功 → response_format 转换（b64↔url）
  → 写 request_logs → 返回 OpenAI images JSON（或 SSE 流）
```

## 3. 对外 API（OpenAI images 格式）

### POST /v1/images/generations

请求体（JSON）：

```json
{
  "model": "gpt-image-1",
  "prompt": "a white cat",
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json",
  "stream": false,
  "quality": "high",
  "user": "optional"
}
```

- `model`、`prompt` 必填；`n` 默认 1（上限 10）；`size` 默认 `auto`，校验 `^\d{3,4}x\d{3,4}$` 或 `auto` 等宽松白名单，未知值原样透传交上游裁决；`response_format` 支持 `url` / `b64_json`，缺省 `url`；`quality`、`style` 等其余字段透传。
- 响应：

```json
{
  "created": 1724900000,
  "data": [
    { "b64_json": "…", "revised_prompt": "…" }
  ]
}
```

- 上游额外字段（如 `usage`）不删除，原样合并进每个 item 或顶层。

### POST /v1/images/edits

- `multipart/form-data`：`image`（可多文件）、可选 `mask`、`prompt`、`model`、`n`、`size`、`response_format`。
- 上游若不接受 multipart（部分中转站只收 JSON），Provider 负责把图片转成 base64 JSON 格式再发（各中转站惯例不同，以"先按 multipart 发、404/415 时回退 JSON base64"为默认策略，策略可通过渠道配置字段 `editMode: multipart | json-base64` 强制指定）。

### GET /v1/models

- 返回 `{"object":"list","data":[{"id":"<对外model>","object":"model",...}]}`，仅列出启用的映射。

### 流式（`stream: true`）

OpenAI images 官方无流式标准，采用自定义 SSE 协议（文档化，借鉴 chat completions 风格）：

```
data: {"type":"status","stage":"submitted"}          # 已转发上游
data: {"type":"progress","message":"generating"}     # 心跳/进度（可选，15s 间隔保活）
data: {"type":"image","index":0,"b64_json":"…"}      # 每张图就绪即推
data: {"type":"completed","created":1724900000,"data":[ …完整 items… ]}
data: [DONE]
```

- 出错时推 `data: {"type":"error","error":{…}}` 后关闭流。
- 流式仅单渠道串行实现：拿到上游完整响应后逐图推送（上游多数不支持真正的增量），`status`/`completed` 事件保证客户端体验。

### 错误格式

统一 OpenAI 错误 JSON，HTTP 状态码尽量沿用上游：

```json
{ "error": { "message": "…", "type": "invalid_request_error", "code": "…" } }
```

- 401/403：对外 `invalid_request_error`/`invalid_api_key`（上游鉴权失败在换 key 重试穷尽后返回，message 标注渠道名）。
- 429：原样透传（含上游 `code`）。
- 上游 5xx/超时：对外 502/504，`type: "upstream_error"` / `"timeout"`。
- 上游返回体若已是 OpenAI 错误结构，message/code 保留，type 规范化。
- 请求体非法：400 `invalid_request_error`；model 未映射：404 `model_not_found`。

## 4. Provider 接口

```ts
interface ImageProvider {
  readonly kind: string; // "openai-compat"
  generate(req: UnifiedGenRequest, ctx: CallContext): Promise<UnifiedImageResult>;
  edit(req: UnifiedEditRequest, ctx: CallContext): Promise<UnifiedImageResult>;
  test(channel: ChannelConfig): Promise<{ ok: boolean; message: string }>; // 管理后台连通性测试（GET /models）
}

interface CallContext {
  channel: ChannelConfig;  // baseURL、超时、editMode、extraHeaders
  apiKey: string;
  signal: AbortSignal;     // 超时/取消
}
```

- `UnifiedGenRequest`：prompt、n、size、quality、responseFormat、passthrough(其余字段)、stream。
- `UnifiedImageResult`：`images: { b64?: string; url?: string; revisedPrompt?: string }[]`、`created`、`raw`（透传原始 JSON 备用）。
- 第一版只实现 `OpenAICompatProvider`；OpenAI 官方与中转站共用，仅 baseURL/key/差异修补（editMode）不同。新增非兼容渠道时实现新 Provider 并在渠道类型里注册。

## 5. 数据模型（SQLite，better-sqlite3）

运行时唯一配置来源是 SQLite（`/data/tiny-images.db`）。

- `channels`：`id`、`name`（唯一）、`type`（固定 openai-compat）、`base_url`、`timeout_ms`（默认 120000）、`edit_mode`（auto|multipart|json-base64）、`extra_headers`（JSON）、`enabled`、`created_at`
- `channel_keys`：`id`、`channel_id`、`api_key`、`enabled`、`cooldown_until`（失败冷却，默认 60s，仅内存判断亦可，持久化便于重启保留）
- `models`：`id`、`public_name`（对外名，**启用中的映射间不允许重复**——本版不做同 model 多渠道切换）、`channel_id`、`upstream_name`（缺省同 public_name）、`enabled`、`created_at`
- `api_keys`：`id`、`name`、`key`（`sk-tiny-` 前缀随机生成）、`enabled`、`created_at`
- `request_logs`：`id`、`ts`、`model`、`channel_id`、`api_key_id`、`status`（ok|error）、`http_status`、`latency_ms`、`error_message`；保留最近 1000 条，插入时淘汰

### 配置引导

首次启动（库为空）时若存在 `/data/config.yaml` 则导入种子数据（channels/keys/models），格式：

```yaml
channels:
  - name: openai
    baseUrl: https://api.openai.com/v1
    keys: [sk-xxx]
    timeoutMs: 120000
models:
  - name: gpt-image-1
    channel: openai
    upstream: gpt-image-1
```

## 6. 鉴权

- **对外 API**（/v1/\*）：`Authorization: Bearer <api_keys.key>`；表为空时放行（本地调试友好），非空即强制校验。
- **管理后台**（/admin/\*）：`Authorization: Bearer <ADMIN_TOKEN>`。`ADMIN_TOKEN` 未设置时，管理 API 仅接受来自 localhost 的请求。前端登录页输入 token，存 localStorage。
- `/files/*`（b64 转 url 的图片缓存）：随机文件名不可枚举，不做额外鉴权。

## 7. 图片格式转换（media/b64cache）

- 上游只回 `url` 而客户端要 `b64_json`：服务端拉取图片字节转 base64（超时同渠道 timeout，失败则报 `upstream_error`）。
- 上游只回 `b64_json` 而客户端要 `url`：写入 `/data/generated/<uuid>.png`，返回 `<PUBLIC_BASE_URL>/files/<uuid>.png`；TTL 24h，启动时 + 每小时清理过期文件。`PUBLIC_BASE_URL` 环境变量（缺省用请求 Host 头推导）。

## 8. Web UI

React 18 + Vite + TypeScript，路由用 react-router-dom，样式为单个手写 CSS 文件（无组件库）。构建产物由 Fastify 静态托管（SPA fallback 到 index.html）。

1. **Login**（/login）：输入 ADMIN_TOKEN，校验后存 localStorage 并跳转。
2. **Playground**（/）：
   - 表单：model 下拉（GET /v1/models）、prompt、n、size、response_format、stream 开关、高级参数 JSON 框（透传）。
   - 结果：图片画廊（b64 直接内联显示）、命中渠道、耗时、错误展示。
3. **Admin**（/admin）：
   - Tab 渠道：列表 + 新建/编辑（name、baseURL、timeout、editMode、extraHeaders）、启用开关、key 池子表管理（增删/启停）、"测试连通性"按钮（调 test 接口显示结果）。
   - Tab 模型映射：public_name、渠道选择、upstream_name、启停。
   - Tab API Keys：生成新 key（一次性明文展示）、名称、启停。
   - Tab 日志：最近请求表（时间、model、渠道、状态、耗时、错误摘要），自动刷新。

## 9. 关键实现约定

- Node 22 + TypeScript（ESM）+ Fastify 5；HTTP 客户端用原生 fetch（Node 22 内置），SSE 手写拼接。
- 环境变量：`PORT`（默认 3000）、`DATA_DIR`（默认 ./data）、`ADMIN_TOKEN`、`PUBLIC_BASE_URL`。
- 日志：pino（Fastify 内置），请求日志同时落 request_logs 表。
- 测试：Vitest；单测覆盖 router、keyPool、errors 映射、b64cache；集成测试用 supertest + 本地 mock 上游（fastify 起一个假 OpenAI images 端点），覆盖 generations/edits/models/鉴权/流式/错误映射。
- npm workspaces：`server` 与 `web` 两个包，根目录统一脚本（`npm run dev`、`npm run build`、`npm test`）。

## 10. 里程碑（实施顺序）

1. **M1 核心同步链路**：骨架、store、router/keyPool、OpenAICompatProvider、`/v1/images/generations`（非流式）+ 鉴权 + 错误映射。
2. **M2 完整 API**：edits（含 multipart/json 回退）、`/v1/models`、b64↔url 转换、request_logs。
3. **M3 流式**：SSE 协议与 playground 所需的完整语义。
4. **M4 Admin API**：渠道/映射/key/日志 CRUD 与连通性测试。
5. **M5 Web UI**：Login、Playground、Admin 后台。
6. **M6 Docker 部署**：多阶段 Dockerfile、docker-compose、README。

### 验收标准

- OpenAI 官方 SDK（node 或 python）将 baseURL 指向本服务、api_key 指向 api_keys 表中的 key，`client.images.generate(...)` 成功返回图片；`images.edit` 同理。
- 管理后台可完成"新增渠道 → 录入 key → 建 model 映射 → playground 出图"全流程，无需手改文件。
- `npm test` 全绿。
- （M6 后）`docker compose up -d` 后服务可用且数据持久化。
