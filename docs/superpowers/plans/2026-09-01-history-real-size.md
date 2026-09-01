# 历史图片真实分辨率 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让历史记录在请求尺寸为 `auto` 时显示图片实际分辨率，并兼容没有尺寸元数据的旧记录。

**Architecture:** 服务端在图片本地化的唯一入口使用 `sharp` 从实际图片 buffer 提取尺寸，并把 `width`/`height` 随文件名保存到 job/history 的图片 JSON。前端优先使用持久化尺寸，旧记录则在 `<img>` 的 `load` 事件中读取 `naturalWidth`/`naturalHeight`，最后才回退到超分目标尺寸或请求尺寸。

**Tech Stack:** Node.js 22、TypeScript、Fastify、SQLite JSON history、sharp、React 18、Vitest、Vite。

---

## 文件职责

- `server/src/media/b64cache.ts`：下载/解码/保存图片，并返回本地化图片的真实尺寸。
- `server/src/server/jobs.ts`：定义可选尺寸的 job 图片类型。
- `server/src/server/history.ts`：把尺寸贯穿后台生成/编辑 job，并输出给 job/history API。
- `server/src/server/generations.ts`：把尺寸贯穿同步历史提取。
- `server/src/server/stream.ts`：把尺寸贯穿流式历史提取。
- `server/src/server/upscale.ts`：把已验证的 Cloudflare 超分输出尺寸写入 job/history。
- `web/src/api.ts`：补充 job 图片响应的可选尺寸类型。
- `web/src/pages/History.tsx`：统一尺寸优先级、加载回退和历史页面显示。
- `server/tests/b64cache.test.ts`、`server/tests/v1-history.test.ts`、`server/tests/v1-upscale.test.ts`：服务端真实尺寸回归覆盖。
- `web/src/pages/History.test.tsx`：前端持久化尺寸与浏览器回退回归覆盖。

## Task 1: 写服务端红色测试

**Files:**

- Modify: `server/tests/b64cache.test.ts`
- Modify: `server/tests/v1-history.test.ts`
- Modify: `server/tests/v1-upscale.test.ts`

- [ ] **Step 1: 为本地化图片写真实尺寸断言**

在 `server/tests/b64cache.test.ts` 引入 `sharp`，用 `sharp({ create: { width: 2, height: 3, channels: 4, background: ... } }).png().toBuffer()` 生成非正方形 fixture。调用 `localizeImage` 的 base64 和 URL 两条路径，并断言结果分别包含 `{ width: 2, height: 3 }`；保留现有文件存在和失败返回 `null` 断言。

- [ ] **Step 2: 为后台/同步历史写 API 尺寸断言**

在 `server/tests/v1-history.test.ts` 的后台生成成功测试中，断言轮询返回的第一张图片和 `JSON.parse(row.images)[0]` 都包含 `{ width: 1, height: 1 }`。在同步 URL 历史测试中同样断言落库对象有 `width: 1`、`height: 1`。

- [ ] **Step 3: 为超分 job 写输出尺寸断言**

在 `server/tests/v1-upscale.test.ts` 的成功测试中，将 job 图片类型扩展为可选尺寸并断言轮询图片与 `row.images` 都包含 `{ width: 8, height: 6 }`。这是输出 buffer 已由 `fetchCloudflareUpscale` 校验后的实际尺寸。

- [ ] **Step 4: 运行服务端指定测试确认失败原因正确**

运行：

```bash
npm test -w server -- --run server/tests/b64cache.test.ts server/tests/v1-history.test.ts server/tests/v1-upscale.test.ts
```

预期：新增的尺寸断言失败，原因是当前 `localizeImage`、job 图片和超分历史对象没有 `width`/`height`；不得先修改生产代码来绕过失败。

- [ ] **Step 5: 提交红色测试**

```bash
git add server/tests/b64cache.test.ts server/tests/v1-history.test.ts server/tests/v1-upscale.test.ts
git commit -m "test(server): cover persisted history image dimensions"
```

## Task 2: 实现服务端尺寸元数据贯穿

**Files:**

- Modify: `server/src/media/b64cache.ts`
- Modify: `server/src/server/jobs.ts`
- Modify: `server/src/server/history.ts`
- Modify: `server/src/server/generations.ts`
- Modify: `server/src/server/stream.ts`
- Modify: `server/src/server/upscale.ts`

- [ ] **Step 1: 在本地化入口解码并返回尺寸**

在 `b64cache.ts` 引入现有 `sharp` 依赖，定义并导出或内部复用：

```ts
type ImageDimensions = { width: number; height: number };
type LocalizedImage = { file: string } & ImageDimensions;
```

`localizeImage` 取得 base64 buffer 后执行 `sharp(buffer, { failOn: "error" }).metadata()`，使用 `metadata.autoOrient?.width ?? metadata.width` 与对应 height，只有两个值为正整数时才调用 `saveGeneratedImage` 并返回 `{ file, width, height }`。捕获下载、解码和保存异常后返回 `null`。保持 `saveGeneratedImage` 的同步返回签名，避免影响普通响应 URL 转换。

- [ ] **Step 2: 扩展图片类型并更新后台生成/编辑路径**

在 `JobImage` 和 `history.ts` 内部图片类型增加可选 `width`/`height`。普通生成和编辑调用 `localizeImage` 后，把 `saved.width`、`saved.height` 与文件名、`revisedPrompt` 一起放入 job 和 `generations.images`。

- [ ] **Step 3: 更新同步与流式历史提取**

让 `extractHistoryImages` 与 `recordStreamGeneration` 的输出对象复制本地化结果的尺寸；不要改变客户端同步/流式响应的 OpenAI 兼容形状。

- [ ] **Step 4: 更新超分历史图片**

在 `runUpscaleJob` 保存 Cloudflare 输出时保留 `output.width`、`output.height`，让 job `addImage` 和 `completeGeneration` 使用同一个 `{ file, width, height }` 对象。不要重新解码或仅依赖请求参数覆盖已验证的输出元数据。

- [ ] **Step 5: 运行服务端指定测试确认变绿**

```bash
npm test -w server -- --run server/tests/b64cache.test.ts server/tests/v1-history.test.ts server/tests/v1-upscale.test.ts
```

预期：新增尺寸断言和该三个文件中的既有测试全部通过；若失败，修复生产代码而不是放宽断言。

- [ ] **Step 6: 提交服务端实现**

```bash
git add server/src/media/b64cache.ts server/src/server/jobs.ts server/src/server/history.ts server/src/server/generations.ts server/src/server/stream.ts server/src/server/upscale.ts server/tests/b64cache.test.ts server/tests/v1-history.test.ts server/tests/v1-upscale.test.ts
git commit -m "fix(server): persist generated image dimensions"
```

## Task 3: 写前端红色回归测试

**Files:**

- Modify: `web/src/pages/History.test.tsx`

- [ ] **Step 1: 增加服务端尺寸优先测试数据**

给一条 `params: {}` 的历史图片增加 `width: 640`、`height: 480`，渲染历史页并断言墙砖显示 `尺寸: 640x480`，证明 `auto` 不再覆盖已返回的真实尺寸。

- [ ] **Step 2: 增加旧记录自然尺寸回退测试**

给一条没有 `width`/`height` 且 `params: {}` 的图片渲染历史页，先断言显示 `尺寸: 未知`。随后给墙砖 `<img>` 定义 `naturalWidth = 320`、`naturalHeight = 240` 并派发 `load` 事件，断言尺寸更新为 `尺寸: 320x240`；点击墙砖打开详情后，详情元信息也应显示该值。

- [ ] **Step 3: 运行前端测试确认失败原因正确**

```bash
npm test -w web -- --run web/src/pages/History.test.tsx
```

预期：新增断言失败，因为当前历史图片类型没有尺寸、页面没有 `onLoad` 尺寸状态或 `未知` 回退。

- [ ] **Step 4: 提交前端红色测试**

```bash
git add web/src/pages/History.test.tsx
git commit -m "test(web): cover real history image dimensions"
```

## Task 4: 实现前端尺寸优先级与回退

**Files:**

- Modify: `web/src/pages/History.tsx`
- Modify: `web/src/api.ts`
- Test: `web/src/pages/History.test.tsx`

- [ ] **Step 1: 扩展类型并实现严格尺寸格式化**

给 `HistoryImage` 和 `JobImage` 增加 `width?: number`、`height?: number`。在 `History.tsx` 中只接受正整数宽高，新增图片尺寸格式化函数，并让 `historyItemSize` 按以下顺序取值：第一张图片持久化尺寸、传入的浏览器加载尺寸、超分目标尺寸、普通 `params.size`，最后返回 `未知`。

- [ ] **Step 2: 记录图片加载后的自然尺寸**

新增以 `${item.id}:${imageIndex}` 为键的状态。`onLoad` 读取 `event.currentTarget.naturalWidth`/`naturalHeight`，两者有效时更新对应状态；相同尺寸不重复写入。墙砖封面和详情图片都绑定同一个处理函数。

- [ ] **Step 3: 在墙砖和详情使用统一尺寸**

墙砖使用第一张图的状态计算尺寸，详情元信息使用详情第一张图的状态计算尺寸；保留已有超分和显式编辑按钮行为、过期处理与图片点击不导航行为。新记录优先显示 API 的 `width`/`height`，旧 `auto` 记录在图片加载后更新。

- [ ] **Step 4: 运行前端指定测试确认变绿**

```bash
npm test -w web -- --run web/src/pages/History.test.tsx
```

预期：History 测试全部通过，包括历史图片点击、显式编辑、普通/超分尺寸以及新增的持久化尺寸和自然尺寸回退。

- [ ] **Step 5: 提交前端实现**

```bash
git add web/src/pages/History.tsx web/src/api.ts web/src/pages/History.test.tsx
git commit -m "fix(web): show real dimensions for history images"
```

## Task 5: 全量验证、审查与集成

- [ ] **Step 1: 检查当前分支差异**

```bash
git diff --check main...HEAD
git status --short --branch
git log --oneline --decorate -6
```

预期：无空白错误，所有任务文件都在本分支提交中，没有意外生成物。

- [ ] **Step 2: 运行完整测试与构建**

```bash
npm test
npm run build
```

预期：服务端与前端所有测试退出码为 0，生产构建退出码为 0。若构建更新已跟踪的 `web/tsconfig.tsbuildinfo`，恢复该缓存文件，不把它作为功能改动提交。

- [ ] **Step 3: 请求代码审查并处理反馈**

以 `main` 与当前 HEAD 的 SHA 为范围，检查服务端所有本地化路径、旧记录兼容和前端 `onLoad` 回退。Critical/Important 问题先修复，再重复受影响测试与完整验证；审查无阻塞问题后继续集成。

- [ ] **Step 4: 在主 worktree 合并并验证**

在主 worktree 确认没有用户改动后拉取远端 `main`，合并 `codex/history-real-size`，在合并结果再次运行：

```bash
npm test
npm run build
git diff --check HEAD~1..HEAD
```

- [ ] **Step 5: 推送并清理**

确认合并结果测试和构建均通过后，将 `main` 推送到 `origin/main`，删除已合并的临时分支并移除 `.worktrees/history-real-size`；保留现有 `.worktrees/nsfw-access-control`。
