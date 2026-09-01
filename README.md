# tiny-images

生图 API 聚合网关：把多个上游生图渠道（OpenAI 官方、各类 OpenAI 兼容中转站、AI Horde）统一成 **ChatGPT/OpenAI images API 格式** 对外暴露，任何 OpenAI SDK 只需改 `baseURL` 即可使用。自带 Web Playground（调试出图）与管理后台（渠道 / key 池 / 模型映射 / 日志）。

## 功能

- **OpenAI images 兼容 API**：`POST /v1/images/generations`、`POST /v1/images/edits`（multipart，含 JSON 回退）、`GET /v1/models`
- **原生 AI Horde**：支持异步生成轮询、img2img 和 inpainting，并可通过 `horde` 命名空间传递 Horde 专属参数
- **流式生成**：请求体 `"stream": true` 走 SSE（自定义协议，见下文）
- **Cloudflare Images 超分**：可选的单图 2×/4× AI 放大后台任务，结果本地化到现有 `/files/*` 生命周期
- **渠道与 key 池**：每渠道多 apiKey 轮询；401/403/429 自动冷却换 key 重试
- **模型映射**：对外 model 名 → （渠道，上游 model 名）；启用中的映射名唯一
- **b64 ↔ url 自动转换**：客户端要的格式与上游返回的不一致时自动转换（b64→url 落盘缓存 24h）
- **统一错误格式**：所有错误均为 OpenAI 结构 `{"error":{"message","type","code"}}`
- **WebUI**：Playground + 管理后台（React），由服务端同端口托管
- **鉴权**：对外 API 用 `sk-tiny-` 前缀 key（未配置任何 key 时不鉴权）；Web 登录用邮箱+密码（admin / 普通用户角色，普通用户可配置额度与可用渠道分组）
- **持久化**：SQLite（Node 内置 `node:sqlite`，无原生编译依赖），配置即数据、改完即生效

## 快速开始

### Docker（推荐）

```bash
# 首次启动必须设置初始管理员账号（仅 users 表为空时生效）
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=你的密码 docker compose up -d
```

打开 http://localhost:3000 → 用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 登录 → 「管理后台」建渠道、录 key、建映射 → 回 Playground 出图。

### 本地开发

```bash
npm install
npm run build          # 构建 web/dist 与 server/dist
npm run dev            # 后端 :3000（tsx watch）
npm run dev:web        # 前端 :5173（Vite 代理 /v1 /admin /files 到 :3000）
npm test               # Vitest 全量测试
node server/scripts/e2e.ts  # 端到端冒烟（内置 mock 上游，无需真实渠道）
```

## 配置

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `./data` | 数据目录（SQLite、生成图缓存、可选 config.yaml） |
| `ADMIN_EMAIL` | 无 | 首次启动创建初始 admin 的邮箱（users 表为空时必填，否则拒绝启动） |
| `ADMIN_PASSWORD` | 无 | 首次启动创建初始 admin 的密码（同上） |
| `JWT_SECRET` | 自动生成 | 登录 token 签名密钥；默认生成并持久化到 `DATA_DIR/jwt_secret` |
| `PUBLIC_BASE_URL` | 空 | 生成图对外 URL 的基地址；为空时按请求 Host 推导 |
| `CLOUDFLARE_IMAGES_ENABLED` | `false` | 仅设为 `true` 时启用图片超分 |
| `CLOUDFLARE_IMAGES_BASE_URL` | 空 | 启用时必填：接入 Cloudflare 代理并启用 Image Resizing 的 HTTPS 站点根地址；不得含路径、query、凭据，也不能是 localhost/IP |
| `CLOUDFLARE_IMAGES_TIMEOUT_MS` | `120000` | Cloudflare 首次 AI 变换超时，范围 10000–300000 ms |
| `UPSCALE_MAX_INPUT_BYTES` | `20971520` | 超分输入上限（20 MiB） |
| `UPSCALE_MAX_INPUT_PIXELS` | `40000000` | 超分输入解码像素上限 |
| `UPSCALE_MAX_DIMENSION` | `8192` | 放大后宽或高的上限 |
| `UPSCALE_MAX_OUTPUT_BYTES` | `52428800` | Cloudflare 响应流上限（50 MiB） |
| `UPSCALE_CONCURRENCY` | `2` | 单进程超分请求并发数，范围 1–16 |

### 管理设置

管理员可在「管理后台 → 设置」编辑全局提示词和公告。全局提示词会在服务端前置到所有生成与图片编辑请求，但历史记录仍保留用户原始提示词。非空公告会在 Playground 自动弹出；用户点击“知道了”后当前浏览器不再显示该版本，管理员修改公告后会再次显示。

首次启动若 `DATA_DIR/config.yaml` 存在且数据库为空，会导入种子数据：

```yaml
channels:
  - name: openai
    baseUrl: https://api.openai.com/v1
    keys: [sk-xxx]
    timeoutMs: 120000
  - name: horde
    type: ai-horde
    baseUrl: https://aihorde.net/api/v2
    keys: ["0000000000"] # 匿名 key；也可替换为注册账号的 key
models:
  - name: gpt-image-1
    channel: openai
    upstream: gpt-image-1
  - name: pony
    channel: horde
    upstream: Pony Diffusion
```

## API 用法

### OpenAI SDK（node）

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:3000/v1", apiKey: "<sk-tiny-…>" });

const res = await client.images.generate({
  model: "gpt-image-1",       // 你在管理后台映射的对外名
  prompt: "a white cat",
  n: 1,
});
console.log(res.data[0].b64_json ?? res.data[0].url);
```

### curl

```bash
curl http://localhost:3000/v1/images/generations \
  -H "Authorization: Bearer sk-tiny-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-1","prompt":"a white cat","n":1}'
```

- 未指定 `response_format` 时按上游原生格式返回；显式指定 `url` / `b64_json` 时网关自动转换。
- OpenAI 兼容渠道会原样透传 `quality`、`style` 等其余参数（`response_format` 除外，转换由网关本地完成）。

### AI Horde

将对外模型映射到 `ai-horde` 渠道后，请求仍使用 OpenAI images 路径。Horde 专属选项放在顶层 `horde` 对象中，避免被发送到其他类型的上游：

```bash
curl http://localhost:3000/v1/images/generations \
  -H "Authorization: Bearer sk-tiny-…" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pony",
    "prompt": "a white cat",
    "n": 1,
    "size": "1024x1024",
    "horde": {
      "nsfw": true,
      "params": { "steps": 25, "sampler_name": "k_euler" }
    }
  }'
```

`model` 映射、`n` 和明确的 `size` 优先于 `horde.params` 中的同名设置；`quality` 对 AI Horde 不生效。AI Horde 是 worker 排队式服务，耗时和模型可用性取决于当前在线 worker。

`POST /v1/images/edits` 在没有 `mask` 时使用 img2img，有 `mask` 时使用 inpainting。每次只接受一张源图，mask 尺寸必须与源图一致；网关使用 `sharp` 将 PNG、JPEG 或 WebP 源图和 mask 转为 AI Horde 所需的 Base64 WebP。实际编辑能力仍取决于所选模型和在线 worker。

### Cloudflare Images 图片超分

此功能默认关闭，运行时不使用 Cloudflare API token。启用前需将 `CLOUDFLARE_IMAGES_BASE_URL` 对应域名接入 Cloudflare 代理，并在同一 Zone 启用 **Image Resizing / Transform Images**；该域名必须能回源访问本服务的随机 `/upscale-inputs/*` 路径。

```bash
CLOUDFLARE_IMAGES_ENABLED=true \
CLOUDFLARE_IMAGES_BASE_URL=https://images.example.com \
docker compose up -d
```

功能探测接口为 `GET /v1/features`。创建任务使用已鉴权的单图 multipart 请求，只接受 PNG、JPEG 或 WebP，`scale` 为 `2`（默认）或 `4`，`response_format` 仅支持 `url`：

```bash
curl http://localhost:3000/v1/images/upscale-jobs \
  -H "Authorization: Bearer sk-tiny-…" \
  -F "image=@source.png" \
  -F "scale=2"
```

接口立即返回 `{"jobId":"…"}`，随后通过 `GET /v1/images/jobs/:id` 轮询 `running / ok / error`。服务端将输入暂存为随机文件，构造同站点 `/cdn-cgi/image/width=…,height=…,fit=contain,upscale=generate,format=auto/...` URL，严格验证 Cloudflare 输出后安全写入 `DATA_DIR/generated`。成功会立即删除暂存输入；失败暂存保留至 24 小时 TTL 清理。暂存目录与生成图会在启动时及每小时清理。

### 流式（SSE）

请求体加 `"stream": true`，响应为 `text/event-stream`：

```
data: {"type":"status","stage":"submitted"}       # 已转发上游
data: {"type":"progress","message":"generating"}  # 15s 心跳
data: {"type":"image","index":0,"b64_json":"…"}   # 每张图就绪即推
data: {"type":"completed","created":…,"data":[…]} # 完整 OpenAI images 响应
data: [DONE]
```

失败时推送 `data: {"type":"error","error":{…}}` 后关闭流（无 `[DONE]`）。校验与路由错误发生在流开始之前，仍返回普通 JSON 错误。

## 架构

```
server/src
├─ server/     HTTP 层：/v1（generations/edits/models）、/admin、/files、SSE
├─ core/       executor 编排、model 路由、key 池、OpenAI 错误映射
├─ providers/  OpenAICompatProvider 与 AIHordeProvider（生成轮询、图片编辑转换）
├─ store/      SQLite 迁移、Repo、config.yaml 种子导入
└─ media/      b64↔url 转换与生成图 TTL 缓存
web/src        React：Login / Playground / Admin
```

数据流：`请求 → Bearer 鉴权 → 参数校验 → model 映射到渠道 → key 池取 key → 上游调用（401/403/429 换 key 重试）→ 格式转换 → 写日志 → 响应`。

## 限制

- 内置支持 OpenAI 兼容上游和 AI Horde；其他非兼容协议仍需实现新的 Provider。
- 启用中的对外 model 名全局唯一（不做同 model 多渠道切换）。
- `request_logs` 仅保留最近 50 条。
- 生成历史记录保留 7 天；历史图片文件仍按 24 小时 TTL 清理，图片过期后可继续查看 prompt 并重新生成。
