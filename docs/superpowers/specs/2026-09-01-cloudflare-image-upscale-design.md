# 基于 Cloudflare Images 的图片超分辨率设计

日期：2026-09-01  
状态：提案，待确认

## 背景

当前 tiny-images 已支持文生图和图片编辑。图片编辑及生成结果会按调用方要求转换为 URL 或 Base64；需要 URL 时，服务端把图片写入 `DATA_DIR/generated`，经随机文件名的 `/files/*` 提供访问，并在 24 小时后清理。

Cloudflare Image Resizing 提供 `upscale=generate`：当图片需要放大时，Cloudflare 使用基于 ESRGAN 的 AI 放大能力生成更清晰的结果。首次转换含 GPU 推理延迟；相同源图及参数的后续请求可命中 Cloudflare 缓存。它适合为 Playground、API 和历史中的普通图片提供 2 倍或 4 倍放大，但不应承诺还原原图中不存在的真实文字或纹理。

本设计把 Cloudflare Images 作为**边缘超分执行器**，保留 tiny-images 作为任务编排、权限控制、历史记录和最终文件生命周期的唯一负责方。

## 目标

- 提供独立的图片超分任务接口，允许调用者上传一张 PNG、JPEG 或 WebP 图片，选择 2 倍或 4 倍目标尺寸。
- Playground 增加与“文生图”“图片编辑”并列的“图片超分”顶层面板，支持本地上传单张图片并选择 2× 或 4×。
- 使用 Cloudflare 的 `upscale=generate`，而不是在应用容器内引入 GPU、PyTorch 或自托管模型。
- 超分任务复用现有异步 job 语义：快速返回 job ID、前端轮询 `running / completed / error`，任务完成后返回常规 `/files/*` URL。
- 成功结果写入现有历史记录，并沿用现有 24 小时图片清理与七天历史保留策略。
- 未配置 Cloudflare 时，已有文生图、图片编辑和 `/files/*` 行为完全不变；UI 明确显示超分不可用。

## 非目标

- 不将 Cloudflare 的 CDN resize 当成精确的科学、司法、医学或 OCR 修复工具；生成的细节不保证真实。
- 不实现任意倍率、去噪、人脸修复、去 JPEG 伪影或批量超分。第一版只支持单图 2× / 4×。
- 不把 Cloudflare 的派生 URL 直接长期暴露为最终结果，也不要求客户端自行轮询 Cloudflare。
- 不新增 R2、Cloudflare Images 托管存储、Workers 或 Durable Objects；源图和最终图继续由当前服务的 `/files/*` 承载。
- 不提供百分比进度、精确剩余时间或 Cloudflare 内部 job ID。Cloudflare 的 URL 转换是同步的：服务端只能确认“请求尚未返回”或“已收到图像 / 已失败”。

## 方案概览

### 架构与数据流

```text
浏览器 / API 客户端
  └─ POST /v1/images/upscale-jobs (multipart: image, scale)
       └─ tiny-images
            1. 校验并暂存输入图片为随机 /files/* URL
            2. 建立本地 job 和 pending 历史记录
            3. 后台请求 Cloudflare 变换 URL
                 https://<PUBLIC_BASE_URL>/cdn-cgi/image/
                   width=<targetWidth>,height=<targetHeight>,fit=contain,
                   upscale=generate,format=auto/<staged-file-path>
            4. Cloudflare 拉取源图、执行 ESRGAN、缓存派生图并返回字节
            5. tiny-images 将返回图像本地化为最终 /files/* 文件
            6. 更新 job 与历史为 completed，保存最终文件名
  └─ GET /v1/jobs/:id（现有轮询接口）
       └─ { status, images: [{ url }], latencyMs, ... }
```

这里的 Cloudflare URL 必须使用配置的、已接入 Cloudflare 代理且已启用 Image Resizing 的公开域名。源图使用同一站点的相对 `/files/*` 路径，因此 Cloudflare 可以从当前应用源站抓取它；不会让 API 调用者指定任意远程图片 URL，避免 SSRF 和意外的第三方带宽消耗。

Cloudflare 会以最接近的受支持 2× 或 4×级别运行一次 AI 放大；若请求尺寸仍超过 4×，剩余部分会变为普通双三次插值。第一版因此只对外暴露 2×、4×，避免把“更大尺寸”误标为全程 AI 超分。

### 为什么后台预热后再保存最终文件

直接把 `/cdn-cgi/image/...` 返回给浏览器虽然简单，但存在三个问题：

1. 首次查看结果会让浏览器长时间等待 Cloudflare 推理，应用无法把结果状态写入历史。
2. `/files/*` 源图按当前规则会过期，Cloudflare 派生 URL 的长期可访问性会受源站和缓存刷新影响。
3. API 返回结果的存储位置会和现有生成、编辑任务不一致，历史页和清理策略难以统一。

因此后台 job 会主动请求一次变换 URL，验证结果确实已产生后，把响应字节写为新的最终文件。调用者只看到标准的应用 URL；Cloudflare 仍会缓存首次转换，若同一暂存图和参数被重复请求则可复用缓存。

## Cloudflare 前置条件

部署超分功能前必须完成以下事项：

1. `PUBLIC_BASE_URL` 配置为 HTTPS 公网地址，例如 `https://images.example.com`。
2. 该域名所在 Zone 已接入 Cloudflare 代理，并在 Cloudflare 控制台启用 **Image Resizing / Transform Images**。
3. 源站允许 Cloudflare 请求 `/files/*`，并能正确返回 `Content-Type`、`Cache-Control` 和图片字节。`/files/*` 继续使用随机、不可枚举的文件名。
4. 按 Cloudflare Images 的套餐限制核对额度。Free 计划包含每月 5,000 次唯一图像转换；超出后新转换会失败。计数键与源图及变换参数相关。
5. 为避免客户端绕开超分或将 `/files/*` 用作一般文件分发入口，应用只允许受支持的图片 MIME / magic bytes 写入暂存目录，且不接受调用者传入源 URL。

Cloudflare 的 `/cdn-cgi/image/` 变换结果按源图缓存策略缓存，派生图最短缓存期为一小时。无法单独 purge 一个派生变换 URL；若未来需要失效，应 purge 原图 URL 及其派生项。第一版不主动 purge，因为暂存源图每次均为新的随机文件名。

## 配置

新增以下服务端环境变量：

| 变量 | 必填 | 示例 | 说明 |
| --- | --- | --- | --- |
| `CLOUDFLARE_IMAGES_ENABLED` | 否 | `true` | 仅值为 `true` 时启用超分入口。缺省为 `false`。 |
| `CLOUDFLARE_IMAGES_BASE_URL` | 启用时必填 | `https://images.example.com` | Cloudflare 代理的公网站点根地址。默认不复用 `PUBLIC_BASE_URL`，以防 API 的公开地址与可转换源站不一致。不得指向 IP、localhost 或含路径的 URL。 |
| `CLOUDFLARE_IMAGES_TIMEOUT_MS` | 否 | `120000` | 后台请求首次 AI 变换的超时，默认 120 秒，允许范围为 10 秒至 300 秒。 |
| `UPSCALE_MAX_INPUT_BYTES` | 否 | `20971520` | 输入文件上限，默认 20 MiB，与 Cloudflare Workers Images binding 的输入上限保持一致；URL 变换路径也采用该保守限制。 |
| `UPSCALE_MAX_INPUT_PIXELS` | 否 | `40000000` | 解码后像素上限，默认 4,000 万，防止畸形图片占用过多内存。 |

启动时配置校验规则：

- `CLOUDFLARE_IMAGES_ENABLED=true` 但没有合法 HTTPS `CLOUDFLARE_IMAGES_BASE_URL` 时，服务拒绝启动，防止用户点击后才发现每个任务都失败。
- `CLOUDFLARE_IMAGES_BASE_URL` 与 `PUBLIC_BASE_URL` 可以不同，但必须都由同一部署可访问，并且前者的 `/files/*` 必须回源到本服务。
- 禁止携带用户信息、query 或 fragment，禁止非 HTTPS URL。

## API 设计

超分不是 OpenAI Images API 中的标准端点，因此采用 tiny-images 的自定义异步接口，并沿用现有 API key 鉴权。

### `POST /v1/images/upscale-jobs`

请求为 `multipart/form-data`：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `image` | 是 | 恰好一张 PNG、JPEG 或 WebP；由 magic bytes 而非仅 MIME 判断。 |
| `scale` | 否 | `2` 或 `4`，默认 `2`。 |
| `response_format` | 否 | 第一版只接受 `url`，默认 `url`。 |

成功时立即返回：

```json
{
  "jobId": "job_..."
}
```

字段非法、文件不支持、超过大小或像素上限时，在创建 job 前返回 OpenAI 风格的 400 错误。Cloudflare 超分功能未启用时返回 503：

```json
{
  "error": {
    "message": "图片超分未在当前部署中启用",
    "type": "service_unavailable",
    "code": "upscale_not_configured"
  }
}
```

`GET /v1/jobs/:id` 不需要新协议。超分 job 和当前生成、编辑 job 使用同一序列化格式；第一版增加可选的 `kind: "upscale"`，供 Playground 在恢复任务时选择合适的状态文案。

成功结果示例：

```json
{
  "id": "job_...",
  "kind": "upscale",
  "status": "completed",
  "progress": "超分完成",
  "latencyMs": 18432,
  "images": [
    { "url": "https://api.example.com/files/8c1f....webp" }
  ]
}
```

`latencyMs` 是本服务从开始请求 Cloudflare 到获得并保存输出的实际耗时，不是预测值，也不代表 Cloudflare 单独的 GPU 时间。

### 目标尺寸规则

1. 用 `sharp` 读取输入实际宽、高，不做 EXIF 方向歧义处理后再计算。
2. `scale=2` 时目标为 `width × 2`、`height × 2`；`scale=4` 同理。
3. 目标长边不能超过一个明确的服务端限制（建议第一版为 8,192 像素）；超出时在任务创建前返回 400，而不是静默缩小或让 Cloudflare 的限制变成不确定错误。
4. 构造 Cloudflare 参数时使用 `width`、`height`、`fit=contain` 与 `upscale=generate`，并指定 `format=auto`。实际输出格式由 Cloudflare 根据请求 Accept 协商；最终落盘时由现有 magic-byte 检测决定扩展名。
5. 输出尺寸在保存前由 `sharp` 再次验证：宽高应与目标尺寸一致或在 Cloudflare 文档允许的约束下保持比例。无效、非图片或意外尺寸输出按上游错误处理，不写入历史图片列表。

## 后台任务与文件生命周期

### 输入暂存

新建独立目录 `DATA_DIR/upscale-inputs`，而不是复用 `generated`：

- 接口完成校验后写入 `upscale-inputs/<32-hex>.<ext>`，通过已有安全文件路由以 `/files/<name>` 读取。
- 该文件只作为 Cloudflare 源图，任务成功或失败后不再对业务暴露为结果。
- 成功时，在最终结果已落盘后删除输入；失败时保留至下一次清理，方便短时间重试和故障排查。
- 清理器启动时及每小时删除超过 24 小时的输入暂存文件，与现有 `generated` 文件 TTL 对齐。

输入文件名保持随机且不可预测。暂存阶段的 `/files/*` 公开可读属性与现有生成结果相同；不应把用户身份、提示词或原始文件名编码到路径中。

### 执行步骤

1. 解析 multipart，验证单文件、文件大小、格式、像素上限与 `scale`。
2. 保存输入暂存图，插入 `pending` 历史记录，创建 `kind=upscale` 的 job；返回 job ID。
3. Job 进入 `running`，状态文案为“正在请求 AI 超分…”。
4. 服务端根据配置和随机源路径生成 Cloudflare `/cdn-cgi/image/` URL，并以 `fetch` 请求该 URL。请求携带内部超时信号，但不得转发调用者任意请求头、Cookie 或 Authorization。
5. Cloudflare 返回成功图片后，限制响应大小并校验成功状态、Content-Type 与 magic bytes；调用现有本地化/写盘能力保存最终图。
6. 最终文件成功写入后，job 和对应历史记录原子地更新为成功，结果只引用最终文件 URL；删除输入暂存图。
7. 任一步失败时，job 与历史状态为 `error`，记录经过脱敏的错误信息、实际耗时；不返回 Cloudflare 内部响应内容或配置 URL。

对于 Cloudflare 返回 4xx/5xx、下载超时、响应不是图片、输出超限或暂存源不可访问等情况，前端统一显示“超分失败，可重试”；服务端日志保留 HTTP 状态与安全的诊断信息。若错误表明当月转换额度耗尽，前端使用明确提示“Cloudflare Images 免费/套餐转换额度已耗尽”。

## Playground 交互

### 可用性与入口

- 应用启动配置中增加公开只读的 `features.upscale`，前端据此决定是否显示顶层面板；不要通过一次失败请求来探测功能。
- Playground 顶部现有“文生图”“图片编辑”切换按钮扩展为三个并列选项：“文生图”“图片编辑”“图片超分”。它们属于同一个 Playground 表单组件、共享右侧结果区及 job 轮询机制，但各自只展示需要的字段。
- “图片超分”面板只包含单图上传、原图缩略预览、倍率选择（2× / 4×）和提交按钮；不显示 prompt、模型、数量、尺寸、mask、渠道选择或高级参数。
- 当功能不可用时，“图片超分”顶部按钮隐藏，或禁用并说明“当前部署未配置 Cloudflare Images 超分”；前两种既有模式不受影响。
- 结果画廊及历史图片的操作菜单仅提供“超分”按钮，不在菜单内直接显示或提交 2× / 4×任务。

### 从结果或历史跳转到超分面板

用户在结果画廊或历史图片点击“超分”时：

1. 前端先将该图片拉取为 `File`，与现有“载入编辑”流程一致；不把任意 URL 传到服务端。
2. 拉取成功后，清除图片编辑的 mask，预填超分面板的单张图片，默认选择 2×，切换 Playground 顶部模式为“图片超分”，并滚动到表单顶部。
3. 只完成面板跳转和预填，不自动创建任务；用户可检查原图并自行选择 2× 或 4× 后提交。
4. 拉取失败时保留当前模式与结果，显示“载入图片到超分模式失败：…”；不创建空任务。

这样用户始终能在一个明确的面板中确认倍率和提交操作，也让超分、文生图、图片编辑具有一致的顶部模式切换体验。

### 提交与反馈

1. 用户在“图片超分”面板选择倍率并提交后，前端向 `/v1/images/upscale-jobs` 发送单图 multipart。
2. 成功拿到 job ID 后写入现有 localStorage job 键并开始轮询，不保持上传请求连接。
3. 任务运行时显示“正在进行 AI 超分，首次处理通常比普通图片处理更久”，不显示虚构百分比或倒计时。
4. `completed` 时使用共享的右侧结果区展示最终图，保留下载、再次载入编辑和再次进入超分面板等结果操作。
5. `error` 时在超分面板显示可读错误及重试按钮；图片和倍率保持不丢失。
6. 用户停止等待或离开页面仅停止轮询；后台任务继续完成并进入历史，行为与现有图片编辑 job 一致。

## 安全与可靠性

- **禁止用户控制源 URL。** Cloudflare 仅转换应用刚保存的随机输入路径，避免 SSRF、内网探测与第三方盗用。
- **不在 URL 中传密钥。** Cloudflare 转换 URL 和源图路径不包含 API key、用户 token、原文件名或 prompt。
- **输入和输出双重校验。** 输入使用 magic bytes、文件大小和像素数限制；输出验证 HTTP 成功、类型、magic bytes、响应大小和目标尺寸。
- **请求超时和大小上限。** 所有 Cloudflare fetch 有独立 AbortSignal，响应以流方式限额读取，避免大响应撑满 Node 内存。
- **回环/代理确认。** 部署验收必须确认 `CLOUDFLARE_IMAGES_BASE_URL/files/<staged>` 在 Cloudflare 边缘可以回源成功。若源站错误地把该 URL 再转到自身的 `/cdn-cgi/image/`，可能形成循环，应在启动健康检查或运维检查中发现。
- **内容访问。** `/files/*` 目前依赖随机 URL 作为访问能力。若未来需要私有图片，必须先设计带签名源图访问或 Worker 鉴权；不可依赖模糊、裁剪或转换参数保护内容。
- **并发和配额。** 第一版在进程内为超分 job 单独设置小并发上限（建议 2），避免多个首次 GPU 推理同时占满连接。达到上限的任务排队并显示“等待超分队列”；这不是 Cloudflare 的内部进度。

## 数据与历史

历史记录的参数字段新增：

```json
{
  "operation": "upscale",
  "scale": 2,
  "sourceWidth": 1024,
  "sourceHeight": 768,
  "targetWidth": 2048,
  "targetHeight": 1536,
  "engine": "cloudflare-images-esrgan"
}
```

`model` 可使用固定内部标识 `cloudflare-images-upscale`，`channelId` 保持 `null`，以免将 Cloudflare 混入可配置的生图渠道路由。历史列表将该条目显示为“图片超分”，而不是“文生图”或“图片编辑”。

不保存上传原图的原始文件名、EXIF 元数据或完整 Cloudflare 变换 URL 到 SQLite。

## 测试与验收

### 单元与集成测试

- 环境变量：默认关闭；启用时 URL、超时与上限的合法性校验。
- multipart 校验：只允许单张 PNG/JPEG/WebP，拒绝不支持格式、多个 `image`、非法倍率、超尺寸与超像素输入。
- 目标尺寸计算：横图、竖图、透明 PNG、EXIF 旋转图和触发 8,192 像素限制的图片。
- Cloudflare URL 构造：仅接受配置根地址和随机相对路径；编码正确，包含 `width`、`height`、`fit=contain`、`upscale=generate`、`format=auto`，且没有调用者提供的 URL 或凭据。
- 成功流程：mock Cloudflare 返回图片；job 立即返回 ID，最终 `/files/*` 可访问，历史为成功且引用最终文件，输入暂存被删除。
- 失败流程：mock 429、5xx、非图片内容、响应超时、异常输出尺寸；job 与历史为 error，输入按清理策略处理，不产生最终文件。
- 回归：现有生成、编辑、SSE、`/files/*`、历史清理与未启用部署的测试继续通过。

### 前端测试

- 功能启用时，顶部模式切换展示“图片超分”并可与“文生图”“图片编辑”切换；禁用时不提交请求。
- 超分面板只展示单图上传、预览和 2×/4×倍率；提交内容为单图 multipart 和合法倍率，成功后使用现有 job 轮询流程。
- 点击结果或历史图片的“超分”会拉取为 `File`、预填超分面板、默认选择 2×并切换顶部模式，但不会自动提交；拉取失败时保留当前界面并显示错误。
- `running`、`completed`、`error`、取消轮询、刷新页面恢复任务分别展示正确状态。
- 历史项正确标识为“图片超分”，最终图仍可下载、再次编辑或再次进入超分面板。

### 人工部署验收

1. 在 Cloudflare 代理域名启用 Image Resizing，并确认 Free 或付费套餐有可用转换额度。
2. 上传一张 1024×768 JPEG，运行 2×；验证最终图为 2048×1536，状态进入 completed，历史可见。
3. 同一源的 4×任务验证为 4096×3072；观察首次请求较慢、重复访问变快（Cloudflare 缓存）。
4. 上传带小字号文字的图片，确认产品说明不承诺 OCR 准确性，人工检查不存在误导性说明。
5. 关闭 `CLOUDFLARE_IMAGES_ENABLED` 重启，验证旧功能可用，超分入口不显示或清晰报未配置。

## 实施顺序

1. 增加配置、能力探测与输入暂存目录/清理能力。
2. 实现 Cloudflare 变换 URL 生成器、限制读取和输出校验的独立 media 模块，并为它编写单测。
3. 扩展 job 与历史类型，新增 `POST /v1/images/upscale-jobs`，接入后台队列和失败映射。
4. 在 Playground 增加超分模式、结果卡片 2×/4× 操作、轮询文案与历史标识。
5. 完成 mock 集成测试、前端测试和真实 Cloudflare 环境的人工验收。

## 参考资料

- [Cloudflare Image Resizing：通过 URL 转换图片](https://developers.cloudflare.com/images/transform-images/transform-via-url/)
- [Cloudflare Images 定价](https://developers.cloudflare.com/images/pricing/)
- [Cloudflare Image Transformations 绑定](https://developers.cloudflare.com/images/transform-images/bindings/)
