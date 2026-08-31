# AI Horde Provider 设计

## 目标

为 tiny-images 增加原生 AI Horde 渠道，使现有 OpenAI Images 兼容接口可以调用 AI Horde 的异步图片生成能力。首期覆盖：

- `POST /v1/images/generations`；
- `POST /v1/images/edits`，无 mask 时使用 `img2img`，有 mask 时使用 `inpainting`；
- 同步、SSE 和现有后台任务调用路径；
- AI Horde 的 NSFW、采样器、调度器、LoRA 等扩展参数。

现有 OpenAI 兼容渠道行为保持不变。本次不实现 outpainting、remix、多源图片编辑，也不模拟 OpenAI `quality` 语义。

## 渠道配置

渠道类型收敛为：

- `openai-compat`：现有行为；
- `ai-horde`：新增原生 AI Horde provider。

数据库已有 `channels.type` 字段，不新增迁移。仓储层创建和更新渠道时必须读写类型；已有记录继续使用默认的 `openai-compat`。

管理后台渠道表单新增类型选择。选择 `ai-horde` 时，新渠道的默认 Base URL 为 `https://aihorde.net/api/v2`，但管理员仍可覆盖它，以支持兼容部署。密钥继续使用现有渠道 key 池：注册用户填写 AI Horde API key，匿名调用填写官方匿名 key `0000000000`。渠道超时字段表示一次完整尝试的总时限，包含提交、轮询和最终结果请求。

`editMode` 对 AI Horde 不生效，但保留在现有渠道数据结构中，避免本次引入表结构变化。额外请求头继续可用；provider 固定设置 `apikey` 和 `Client-Agent`，管理员配置的额外头不得覆盖这两个身份头。

## Provider 架构

将 Executor 当前的单一 `provider` 依赖替换为按渠道类型查找 provider 的 registry。registry 至少注册 `openai-compat` 和 `ai-horde`；Executor 完成模型路由后，根据 `channel.type` 选取 provider，再沿用现有密钥轮换、配额扣减、渠道熔断和调用日志逻辑。未知渠道类型返回明确的服务端配置错误，不回退到其他 provider。

新增 `AIHordeProvider`，实现现有 `ImageProvider` 的 `generate`、`edit` 和 `test` 接口。请求使用以下身份头：

```text
apikey: <当前 key 池选出的密钥>
Client-Agent: tiny-images:<当前服务版本>:github.com/zxxx98/tiny-images
```

`test` 不提交生成任务：无密钥时调用 `GET /status/heartbeat` 检查服务心跳；有密钥时调用 `GET /find_user` 验证连通性和密钥，并使匿名 key `0000000000` 可作为合法配置通过测试。

## 对外请求格式

OpenAI 标准字段继续使用现有接口。AI Horde 专属能力放在可选的顶层 `horde` 对象中，避免把 provider 私有字段混入公共参数：

```json
{
  "model": "pony",
  "prompt": "a knight riding through neon rain",
  "size": "1024x1024",
  "n": 1,
  "horde": {
    "nsfw": true,
    "censor_nsfw": false,
    "allow_downgrade": true,
    "shared": false,
    "params": {
      "steps": 25,
      "cfg_scale": 7,
      "sampler_name": "dpmpp_2m_sde",
      "scheduler": "karras",
      "seed": "12345",
      "loras": []
    }
  }
}
```

`horde` 必须是对象；`horde.params` 如存在也必须是对象。请求解析层把 `horde` 识别为保留的 provider 扩展，不再把它视为普通 passthrough 字段。AI Horde provider 消费该对象；OpenAI-compatible provider 忽略它，绝不将其误传给 OpenAI-compatible 上游。AI Horde provider 也不把其余 OpenAI passthrough 对象直接发送给 Horde。

支持的 `horde` 顶层字段为 AI Horde 生成请求中与任务调度相关的普通选项，包括 `nsfw`、`censor_nsfw`、`allow_downgrade`、`shared`、`trusted_workers`、`slow_workers`、`extra_slow_workers`、`disable_batching`、`replacement_filter`、`dry_run` 和 `proxied_account`。`horde.params` 中其余 AI Horde 生成参数透传给上游并由上游校验。为保持 provider 边界清晰，统一请求类型新增可选的 provider 扩展字段来承载 `horde`，而不是让 provider 从任意 passthrough 数据中自行搜索。

下列值始终由 tiny-images 决定，客户端不能通过 `horde` 覆盖：

- `models`：来自当前模型映射的 `upstreamName`；
- `prompt`：来自标准 `prompt`，并保留现有全局提示词处理；
- `source_image`、`source_mask`、`source_processing`：由编辑请求和上传文件决定；
- `r2`：固定为 `true`，使最终结果优先返回可下载 URL；
- `params.n`：由标准 `n` 覆盖；
- `params.width`、`params.height`：标准 `size` 存在时由其解析结果覆盖。

如果标准 `size` 未提供，则保留 `horde.params.width` 和 `horde.params.height`；两者也未提供时使用 AI Horde 上游默认值。标准 `quality` 不映射到 steps 或其他 Horde 参数；需要高分辨率修复时，调用方显式传入 `horde.params.hires_fix`。匿名 key 下即使请求 `shared: false`，AI Horde 也可能按匿名账户规则将任务视为共享任务，tiny-images 不伪造支持保证。

## 图片生成流程

provider 将统一请求转换为 AI Horde payload，然后：

1. `POST /generate/async` 提交任务并取得任务 ID；
2. 提交成功后立即调用一次 `GET /generate/check/{id}`，未完成时至少等待 2 秒再进行下一次检查；
3. `done: true` 后仅调用一次 `GET /generate/status/{id}`；
4. 将 `generations[].img` 转换为统一图片结果。

轮询频率不高于 AI Horde 状态缓存的有效频率，最终 status 接口仅调用一次，避免触发其每分钟限额。`check` 返回 `done: false` 时继续等待；`faulted: true` 或 `is_possible: false` 时立即停止。最终结果中的 URL 交给现有响应格式转换和历史本地化逻辑处理，因此 `response_format=url` 与 `b64_json` 不需要 provider 重复实现下载策略。结果保留可用的 seed、model、censored 等上游原始信息在 `raw` 中，不新增 OpenAI 响应字段。

## 图片编辑流程

AI Horde 编辑首期只接受一张源图。请求包含多张图片时，在向上游提交前返回 OpenAI 风格的 `400 invalid_request_error`。支持 PNG、JPEG 和 WebP 输入，使用 `sharp` 解码并转换为 Base64 WebP：

- 无 mask：设置 `source_image`，并使用 `source_processing: "img2img"`；
- 有 mask：同时设置 `source_image` 与 `source_mask`，并使用 `source_processing: "inpainting"`。

mask 同样转换为 Base64 WebP，并保持其透明度或灰度信息。图片无法解码、mask 无效或尺寸不满足处理要求时返回 400，而不是把损坏数据提交上游。上传继续使用现有的单文件 50 MiB 限制；`sharp` 解码额外设置 40,000,000 像素上限。转换开始前和结束后检查 AbortSignal；信号已中止时不提交上游。这样既不声称 `sharp` 能中断正在运行的原生解码，也能避免中止后继续网络调用。

Horde worker 是否支持 img2img/inpainting 取决于所选模型和当前在线 worker。没有兼容 worker 时应返回明确的 503，不自动退化成普通文生图，也不切换到 outpainting 或 remix。

## 超时、中止与重试

每次渠道尝试使用一个总 deadline，覆盖图片预处理、`/generate/async`、所有 `/check` 轮询、等待间隔以及最终 `/status`。客户端断开、后台任务取消或总 deadline 到期时，AbortSignal 立即中止 fetch 和轮询等待，不再向 AI Horde 发起请求。

任务提交成功后，tiny-images 首期不调用 AI Horde 的取消接口；本地停止等待即可。AI Horde 任务约十分钟后过期，因此渠道超时不得被 provider 静默延长。现有 Executor 只在认证、权限或限流类错误时轮换 key；一旦提交成功后进入轮询，不因轮询错误重新提交同一任务，避免重复扣 kudos 和重复生成。

## 错误映射

AI Horde 错误统一转换为项目现有的 OpenAI 风格错误结构：

- 上游 400：400 `invalid_request_error`；
- 上游 401/403：对应认证或权限错误，并允许现有 key 轮换策略处理；
- 上游 429：429 限流错误，并允许现有 key 轮换策略处理；
- 上游 503 或 `/check` 的 `is_possible: false`：503 `service_unavailable`，错误信息说明当前模型/处理模式没有可用 worker；
- `/check` 的 `faulted: true`：502 `upstream_error`；
- 任务过期、任务 ID 缺失、最终状态无图片或响应结构损坏：502 `upstream_error`；
- 本地总 deadline 到期：现有上游超时错误；
- 客户端主动断开：停止工作，不额外写出响应。

错误消息可以包含 AI Horde 返回的安全、可操作描述，但不得回显 API key、完整源图 Base64 或 mask 数据。

## 管理后台

渠道创建与编辑接口接受并校验 `type`。管理 UI 在类型选择为 AI Horde 时：

- 提示默认 Base URL；
- 提示注册 key 与匿名 key `0000000000` 的区别；
- 说明 AI Horde 是排队式异步服务，响应时间取决于当前 worker；
- 说明编辑能力依赖当前模型和在线 worker。

切换渠道类型不自动删除现有 Base URL、密钥、模型映射或额外头。管理员必须显式保存；这避免误操作造成不可恢复的配置丢失。

## 测试策略

按测试驱动方式实现。provider 单元测试覆盖：

- generation payload 映射、模型映射和 `r2: true`；
- OpenAI `n`、`size` 与受保护字段的优先级；
- `horde.params` 的合法透传及非法对象校验；
- async → 多次 check → 单次 status 的成功流程；
- 轮询间隔、总超时和 AbortSignal 中止；
- `is_possible`、`faulted`、任务过期、空结果和各类 HTTP 状态映射；
- img2img 与 inpainting payload；
- PNG/JPEG/WebP 到 Base64 WebP 的转换，以及损坏图片和多源图拒绝；
- provider `test` 对注册 key、匿名 key 和不可达服务的结果。

Executor 和路由测试覆盖：

- 根据 `channel.type` 选择正确 provider；
- 未知渠道类型失败且不回退；
- AI Horde 仍沿用密钥轮换、配额、熔断和日志；
- 轮询阶段不会重新提交任务。

API 与管理后台测试覆盖：

- generations、同步 edits、SSE 和后台任务均能传递 `horde`；
- 带 mask 和不带 mask 的编辑模式；
- 多图片、非法 `horde` 和非法图片返回 OpenAI 风格 400；
- 渠道类型可创建、读取、更新并在页面正确回显；
- 现有 `openai-compat` 渠道的回归测试保持通过。

## 非目标

- 不提供 AI Horde 模型目录同步或自动创建模型映射；
- 不实现 outpainting、remix 或多源图片编辑；
- 不提供任务取消、队列进度的 OpenAI 扩展响应或 kudos 统计；
- 不把 `quality` 猜测映射为 Horde 参数；
- 不保证所有模型或 worker 都支持 NSFW、LoRA、img2img 或 inpainting；
- 不改变现有历史存储、图片本地化、用户配额和 API key 管理机制。
