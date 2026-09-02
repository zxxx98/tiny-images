# Chat 图片上游适配设计

## 目标

让管理员为每个 OpenAI Compatible 渠道选择图片生成请求方式。外部调用始终保持 `POST /v1/images/generations` 及现有 Images API 响应；内部根据渠道配置请求上游 `/images/generations` 或 `/chat/completions`。

## 配置与兼容性

- 渠道新增 `generationMode: "images" | "chat"`，默认 `images`。
- SQLite 迁移为已有渠道补上默认值，保证升级后行为不变。
- 管理 API、种子配置和 Web 管理后台均支持该字段。
- 该配置只适用于 `openai-compat` 图片生成。图片编辑和 AI Horde 路径保持不变。

## Chat 请求转换

当渠道使用 `chat` 模式时，Provider 请求 `${baseUrl}/chat/completions`，请求体至少包含：

```json
{
  "model": "<映射后的上游模型>",
  "messages": [{ "role": "user", "content": "<最终 prompt>" }],
  "modalities": ["text", "image"]
}
```

`n`、`size`、`quality` 及原有 passthrough 字段继续传递。passthrough 中显式提供的 `modalities` 或其他供应商参数可以覆盖默认值；`model` 和 `messages` 始终由服务端根据模型映射与最终 prompt 构造，避免绕过路由或全局提示词。Images API 的 `response_format` 不发送给 chat 上游；最终格式仍由网关本地转换。

本次只请求非流式 chat 响应。外部现有自定义 SSE 流程仍可在等待 Provider 完成后发送统一结果，不引入上游 Chat SSE 聚合。

## Chat 图片响应解析

解析全部 `choices`，按以下顺序从每项的 `message` 和兼容性的 `delta` 中收集图片：

1. `images[].image_url.url`；
2. `content[]` 内的 `image_url.url`、字符串 `image_url` 或 `data`；
3. 字符串 `content` 中的 Markdown 图片 `![...](...)`；
4. 字符串内容整体就是一个 HTTP(S) URL 或 `data:image/...` URL。

HTTP(S) 值转换为统一结果的 `url`；合法的 `data:image/<type>;base64,<data>` 转换为 `b64`。同一图片值只返回一次。不会从普通自然语言中提取任意链接，以免把引用网页误判为生成图片。

如果响应缺少 `choices` 或没有可识别图片，Provider 返回统一的 `502 upstream_error`。上游非 2xx、网络错误、超时、Key 轮换和熔断继续复用现有处理。

## 对外响应与现有能力

Provider 产生 `UnifiedImageResult` 后继续走现有 `conformImages`，所以客户端仍收到：

```json
{
  "created": 123,
  "data": [{ "url": "https://..." }]
}
```

或：

```json
{
  "created": 123,
  "data": [{ "b64_json": "..." }]
}
```

`created` 优先使用 chat 响应中的数值，否则使用当前 Unix 秒。安全的 `usage` 字段可沿用现有 raw 元数据流程。历史记录、额度扣减、全局提示词、渠道响应头、并发限制和请求日志无需另建路径。

## 测试

- Provider 单元测试覆盖 chat 请求 URL、模型与 prompt 转换、默认 modalities、passthrough 覆盖。
- 解析测试覆盖 `message.images`、内容块、Markdown Base64、Markdown HTTP URL、`delta` 兼容、去重及无图片错误。
- 管理 API、Repo/迁移、种子配置和 Web 渠道表单测试覆盖 `generationMode` 默认值、保存和非法值校验。
- V1 集成测试证明客户端调用 images 路径、上游收到 chat 请求、客户端仍得到标准 Images API 响应。
- 全量测试与生产构建作为完成门槛。
