# 下载时图片水印设计

日期：2026-09-03  
状态：已确认，实施中

## 背景

tiny-images 的生成结果以原图形式存储在 `DATA_DIR/generated` 并经 `/files/*` 提供，历史与 API 返回均为无水印原图。生成的图片会被用户下载后对外分享，希望分享出去的副本带有署名/来源标识。

水印的实现方式只有一条合理路径：**服务端像素合成**。让模型"画"水印位置与样式不可控、每张不一致、会污染画面内容且额外消耗生成额度；而 `sharp` 已是现有依赖，所有生成图都汇入同一落盘点，合成能力现成。

关键决策：**水印只在下载时合成**。库里与 API 返回的原图永远干净、无损可逆，也不改变"OpenAI 兼容 API 返回原图"的语义。

## 目标

- 管理员在设置页集中配置**水印样式**：位置（左上/中上/右上/左下/中下/右下）、字号、不透明度、文字颜色、固定前缀（如站名）。
- 每个登录用户配置**自己的水印**：启用开关 + 署名文字。
- Playground 与历史的「下载」按钮走新的鉴权下载端点；用户启用水印时，返回的副本按「集中样式 + 用户署名文字」合成水印；未启用时原样返回。
- 原图文件、`/files/*`、API 返回结果完全不变。

## 非目标

- 不做 logo/图片水印（样式仅文字）。
- 不提供用户端样式挑选（位置/字号等由管理员统一决定）。
- 不做落盘改写原图，也不提供"打在原图"的选项。
- 不处理动图 WebP 逐帧水印：合成取静态帧输出（生成结果基本都是静态图，可接受）。
- 不改变 `/files/*` 的公开访问语义。

## 方案概览

### 数据流

```text
浏览器「下载」
  └─ GET /v1/download/:name   (Authorization: Bearer <web JWT>)
       └─ tiny-images
            1. 校验文件名合法（复用 /files 的 NAME_RE），读取 DATA_DIR/generated/<name>
            2. 读取请求用户 watermark 配置 + 管理员 watermarkStyle
            3. 用户未启用或最终文字为空 → 原字节透传
            4. 否则 sharp composite 一层全尺寸 SVG 文字 → 同格式 buffer
            5. 以 Content-Disposition: attachment 返回，cache-control: no-store
```

### 数据模型

- 迁移：`ALTER TABLE users ADD COLUMN watermark TEXT;`（JSON `{ enabled: boolean; text: string }`，NULL = 未配置，视为关闭）
- settings 新键 `watermark_style`（JSON）：`{ position, fontSize, opacity, color, prefix }`，缺省值 `br / 20 / 0.6 / "#ffffff" / ""`。
- 最终水印文字 = `prefix` 与 `text` 以 `·` 连接（各自可空；两者皆空则不合成）。

### 合成实现（`server/src/media/watermark.ts`）

- `applyWatermark(buf, style, userText)`：sharp 读尺寸 → 生成**全尺寸 SVG** 文字层（角部 `text-anchor` + 与字号相关的边距），`paint-order: stroke` 黑色描边保证任意底色可读，`fill-opacity` 控制透明度 → composite → 显式 `toFormat` 按原扩展名输出（png/jpeg/webp）。
- XML 转义用户文字；字号 12–128、不透明度 0.1–1、颜色十六进制、position 枚举，服务端校验后使用。

### API

| 端点 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /v1/download/:name` | `requireUser` | 鉴权下载；按用户水印配置决定是否合成 |
| `GET /v1/watermark` | `requireUser` | 返回 `{ enabled, text }` |
| `PUT /v1/watermark` | `requireUser` | 保存用户水印配置（text ≤ 60 字） |
| `PUT /admin/settings`（扩展） | `requireAdmin` | 新增可选 `watermarkStyle` 校验与保存 |

`/v1/download` 仅面向 Web 登录用户；API key 调用方没有水印配置，继续使用 `/files/*`。非 `/files/` 的结果 URL（如上游直链）前端保持原有 `<a download>` 行为，不做水印。

## 前端

- `api.ts`：`WatermarkConfig` / `WatermarkStyle` 类型；`fetchMyWatermark` / `saveMyWatermark`；`downloadImage(url, filename)`——`/files/` URL 走鉴权下载端点取 blob 后 `a[download]`，其余 URL 回退原 anchor 行为。
- `App.tsx`：menubar 新增「个人设置」导航入口（`/settings`）。
- `pages/AccountSettings.tsx`：个人设置页，「下载水印」（启用开关 + 署名文字）与「修改密码」两张卡片，水印配置从顶栏弹窗迁移至此。
- `Playground.tsx` / `History.tsx`：下载改为调用 `downloadImage()`，文件名规则不变。
- `SettingsTab.tsx`：新增「水印样式」区块（位置下拉、字号、不透明度、颜色、固定前缀）。

## 风险与对策

- **Alpine 无 CJK 字体（关键）**：`node:22-alpine` 运行镜像默认没有任何中文字体，SVG 中文会渲染为方框。Dockerfile runtime 阶段增加 `apk add --no-cache fontconfig font-noto-cjk`。`Dockerfile.ci` 按 design 约束不含 RUN，无法装包：在文件头注释说明 CI 部署需自行保证字体，水印文字缺字体时会显示方框。
- **历史 7 天清理**：下载的文件过期后 404，前端沿用现有"已过期"提示路径（下载按钮同样会收到 404 错误提示）。
- **动态 WebP**：合成后输出静态帧，在 spec 层面明确为已知限制。

## 测试与验收

### 服务端测试（`server/tests/watermark.test.ts`）

- 单元：合成后尺寸不变、字节改变；空文字返回原字节；position/opacity 不同产出不同。
- 端点：无 token 401；未启用时字节与原文件一致；启用后字节不同且 `content-disposition` 为 attachment；非法/未知文件名 404。
- 设置：`watermarkStyle` 非法值 400，合法值 GET 往返一致。

### 前端测试

- `downloadImage` 对 `/files/` URL 携带 JWT 请求下载端点并触发保存。
- 水印弹窗保存调用 `PUT /v1/watermark`。

### 人工验收

1. 管理员配置样式（如右下角、白色、0.6、前缀 "tiny-images"），用户开启署名 "张三"。
2. Playground / 历史下载副本含水印 "tiny-images · 张三"，历史页与 API 返回仍是原图。
3. 用户关闭水印后下载与原图逐字节一致。
4. Docker 构建容器内中文署名渲染正常。

## 实施顺序

1. 迁移 + repo 扩展（users.watermark、settings.watermark_style）。
2. `media/watermark.ts` 合成模块 + 单测。
3. `/v1/download/:name` 与 `/v1/watermark` 端点、admin settings 扩展。
4. 前端 api/弹窗/下载按钮/设置区块。
5. Dockerfile 字体、文档、全量测试与构建验证。
