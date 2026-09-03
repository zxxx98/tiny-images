# 广场（照片墙分享）设计

日期：2026-09-03  
状态：已实施

## 背景

tiny-images 的生成结果默认只有两重归属：本人的「历史」页（7 天清理）与 OpenAI 兼容 API 返回（原图 24h 清理，`sweepExpired`）。用户缺少一个把生成图公开、持久的展示位。

广场（Plaza）解决这件事：生成图可一键分享到广场，所有登录用户可见，页面以瀑布流照片墙呈现。

## 目标

- 单张图粒度的分享/取消分享（本人或 admin 可取消）。
- 广场内容**持久**：不受历史 7 天清理与生成图 24h 清理影响。
- 仅登录用户可见（与站点其它页面一致）。
- 瀑布流照片墙（按原图宽高比），点击进入详情弹窗：大图、Prompt、作者、下载、复制 Prompt、用此 Prompt 生成。

## 非目标

- 不做评论、点赞等互动。
- 不做 NSFW 过滤/分级（复用生成侧的额度与权限即可，广场暂不做二次审核）。
- 不改水印下载链路：广场下载按钮保持直链下载（`/v1/download/:name` 仅读 `DATA_DIR/generated`，且广场图属于分享者而非下载者，是否给"下载他人分享"打下载者水印留作后续决策）。
- 不做匿名/游客可见。

## 关键决策

### 1. 分享 = 复制文件 + 快照信息，与历史解耦

历史记录 7 天删除且 `DELETE /v1/history` 会连带删 `generated/` 文件；若广场引用原文件，墙会碎。

因此分享时：

1. 校验调用者对该 generation 有可见性（复用 `getGenerationVisible`）且 status=ok；
2. 把 `generated/<file>` **复制**到 `DATA_DIR/plaza/<file>`（同名，随机 32hex 名天然不冲突）；
3. 在 `plaza_shares` 表快照 model / prompt / revised_prompt / width / height。

`sweepExpired` 只清理 `generated/` 与 `upscale-inputs/`，plaza 目录天然不受影响。

### 2. 幂等分享

`UNIQUE(user_id, file)` + 插入冲突回落读取已有行：同一用户重复分享同一张图返回 200 与已有记录，前端显示「已分享 ✓」。

### 3. 匿名防护

`requireApiKey` 在**无任何 API key 的部署**下会匿名放行（生成接口的兼容行为）。广场仅登录可见，`GET /v1/plaza` 对完全匿名调用（无 JWT 用户且无 API key）显式 401；POST/DELETE 已被 user_id 校验挡住。

### 4. PlayGround 分享需要 generationId

job 轮询接口 `serializeJob` 此前不含 `generationId`；已补充返回，前端完成 job 后保留该 id 供分享按钮使用。

## 数据模型（迁移 v15）

```sql
CREATE TABLE plaza_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_id INTEGER,
  file TEXT NOT NULL,
  width INTEGER, height INTEGER,
  model TEXT, prompt TEXT NOT NULL DEFAULT '', revised_prompt TEXT
);
CREATE INDEX plaza_shares_cursor ON plaza_shares(id DESC);
CREATE UNIQUE INDEX plaza_shares_user_file ON plaza_shares(user_id, file);
```

## API

均挂 `requireApiKey`：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/plaza` | `{ generationId, imageIndex? }`；复制文件+落库；未登录 403、他人记录 404、源文件已过期 400、幂等 200 |
| GET | `/v1/plaza` | `before`/`limit`(默认 30)/`mine=1`；返回 `{ items: [{ id, createdAt, url, width, height, model, prompt, revisedPrompt, author, userId, mine, canDelete }] }`；匿名 401 |
| DELETE | `/v1/plaza/:id` | 本人或 admin；删记录 + 删 `plaza/<file>`，其余 404 |
| GET | `/files/plaza/:name` | 复用 `/files` 的 NAME_RE 校验，读 `DATA_DIR/plaza/` |

URL 由 `fileBaseUrlFor` 拼接，与历史一致（PUBLIC_BASE_URL 或请求 host）。

## 前端

- 新页 `/plaza`（RequireToken），顶栏「广场」入口。
- 瀑布流：`.plaza-wall` 用 CSS `columns: 4 180px`，瓦片 `break-inside: avoid`、图片原比例展示；空态/加载态沿用站点风格。
- 详情弹窗复用历史页的 `detail-overlay` + `win-window` 结构与 `Lightbox`。
- 分享入口两处：Playground 结果区每张图（`shot-actions`）、历史详情弹窗每张图；成功后本地置「已分享 ✓」。

## 测试

`server/tests/v1-plaza.test.ts`：分享复制与静态服务、幂等、他人记录 404 / 匿名 key 403 / 无 key 部署匿名 401、坏入参 400、源文件过期 400、分页与 mine 过滤、删除权限（本人/admin/他人）与文件清理。
