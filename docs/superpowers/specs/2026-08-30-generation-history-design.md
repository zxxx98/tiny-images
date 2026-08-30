# 生成历史 + 可恢复生成请求 设计文档

日期：2026-08-30

## 背景与目标

Playground 页面生成图片的结果只存在 React state 中，路由切换即丢失；服务端虽然把图片落盘到 `data/generated/` 并通过 `/files/:name` 提供访问，但没有记录「哪次请求产生了哪些图」，无法按请求找回。本设计解决两个问题：

1. 生成过程中切走页面再回来，请求仍能继续等结果。
2. 提供一个历史页面，按 API key 查看以往生成的图片。

已确认的决策：

- 历史在服务端持久化（SQLite），跨浏览器、跨会话可查。
- 生成中的请求通过服务端 job 恢复。
- 图片文件的 TTL 清扫策略保持现状；被清扫后历史中显示「已过期」占位。

## 数据层

在 `server/src/store/db.ts` 的迁移数组末尾追加：

```sql
CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  api_key_id INTEGER,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',   -- 请求参数 JSON（不含 prompt）
  status TEXT NOT NULL,                -- pending | ok | error
  channel_id INTEGER,
  latency_ms INTEGER,
  error_message TEXT,
  images TEXT NOT NULL DEFAULT '[]'    -- [{ file, revised_prompt }] file 为 generated/ 下文件名
);
CREATE INDEX IF NOT EXISTS generations_cursor ON generations(id DESC);
```

写入时机：

- `POST /v1/images/jobs`（Playground 专用）：创建即写 `pending`；完成时更新为 `ok`/`error` 并填 `images`、`channel_id`、`latency_ms`、`error_message`。
- `POST /v1/images/generations`（OpenAI 兼容端点）：请求完成时补写一条 `ok`/`error` 记录（含同步与流式路径）。外部 API 调用也进历史。

### 图片本地化

为了让历史长期可看，凡是要写进历史的结果图片一律落到 `data/generated/`：

- 上游返回 `b64_json`：沿用现有 `saveGeneratedImage`。
- 上游返回 `url`：下载后保存本地，历史引用 `/files/xxx`（上游 URL 本身会过期，不可靠）。

兼容端点 `/v1/images/generations` 对外返回格式不变（url 模式仍可返回上游原 URL 或本地 URL，遵循现有 response_format 转换逻辑），落盘仅用于历史引用。

服务端启动时（`index.ts` 现有启动钩子处）把遗留的 `pending` 记录批量更新为 `error`（error_message: "server restarted"），因为内存 job 已丢失。

## 服务端 job 机制

新增 `server/src/server/jobs.ts`（内存 job 注册表）与两个端点，认证方式与其他 `/v1` 端点一致（Bearer API key）：

- `POST /v1/images/jobs`：body 与 `/v1/images/generations` 相同。校验后立即返回 `{ jobId, status: "running" }`，并在后台用现有 executor 流程执行（使用渠道自身 `timeoutMs`，与客户端连接解耦）。客户端断开不影响执行。
- `GET /v1/images/jobs/:id`：仅限创建该 job 的 api_key 查询。返回 `{ status, progress, images, channel, error, createdAt, latencyMs }`。流式过程中已到达的图片随轮询陆续返回；完成后返回最终状态。job 内存保留上限（如 200 条，LRU 淘汰已完成的）防止泄漏；历史查证走 `/v1/history`。

`/v1/history` 端点：

- `GET /v1/history?before=<id>&limit=<n>`，按当前 API key 过滤，按 id 倒序游标分页，limit 上限 100，默认 30。
- 返回 `{ items: [{ id, createdAt, model, prompt, params, status, latencyMs, errorMessage, images: [{ file, url, revisedPrompt }] }] }`，其中 `url` 为 `/files/<file>`。

## 前端

### Playground 改造（web/src/pages/Playground.tsx）

- 生成改走 `POST /v1/images/jobs`，每秒轮询 `GET /v1/images/jobs/:id` 渲染进度与逐张图片；「取消」改为 job 的客户端放弃轮询（服务端任务自然结束，结果进历史）。不再使用 SSE 前端逻辑（兼容端点保留 SSE 不动）。
- jobId 存 localStorage；挂载时若有该 key 名下 `running` 的 job（通过 history 或 job 查询确认）则恢复轮询——实现「切走再回来继续等结果」。
- prompt、模型、尺寸等表单状态存 localStorage 草稿，回来不丢输入。
- 结果区展示逻辑保持：渠道、耗时、逐张显示、下载。

### 历史页面（web/src/pages/History.tsx）

- 导航新增「历史」入口（App.tsx 路由）。
- 倒序网格画廊：每条含图片、prompt（可复制）、模型、时间、状态、耗时。
- 「已过期」处理：`<img>` 加载失败时替换为「已过期」占位块。
- 「用此 prompt 重新生成」：跳转 Playground 并通过路由 state 带上 prompt/模型/尺寸。
- 点击图片放大预览 + 下载。
- 游标分页：底部「加载更多」。

## 错误处理

- job 执行失败：状态置 `error`，轮询端点返回错误消息，前端展示；记录照常入库。
- 轮询 404（job 被淘汰或重启丢失）：前端回退到查 history 最新记录，找不到则提示「任务已丢失」。
- 图片下载（url 本地化）失败：该张图片标记失败但请求整体继续，历史记录该图片缺失。

## 测试与验证

- 服务端：为 job 端点（创建→轮询→完成→落库）、history 端点（key 过滤 + 游标分页）、兼容端点写记录、重启清 pending 各写最小集成测试；若无现成测试框架，则补充 curl 冒烟脚本。
- 前端：沿用 e2e smoke 脚本，新增「生成中切换路由再回来恢复轮询」「历史页能看到刚才的生成」两步。
- 手动验证项：url 模式上游返回时本地副本生成；文件被 TTL 清扫后历史页显示「已过期」。

## 非目标

- 不做管理端的全用户历史视图（admin 仍只看 request_logs）。
- 不改动 OpenAI 兼容 API 的对外契约。
- 不做图片的永久归档/备份。
