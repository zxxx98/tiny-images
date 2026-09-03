# 下载时水印实施计划

日期：2026-09-03  
规格：[2026-09-03-download-watermark-design.md](../specs/2026-09-03-download-watermark-design.md)

## 任务分解

### 1. 数据层

- `server/src/store/db.ts`：migrations 追加 `ALTER TABLE users ADD COLUMN watermark TEXT;`
- `server/src/store/repo.ts`：
  - `UserRow` 增加 `watermark: { enabled: boolean; text: string } | null`，`toUser` 解析 JSON（解析失败视为 null）
  - `getWatermark(userId)` / `setWatermark(userId, { enabled, text })`
  - `AppSettings` 增加 `watermarkStyle: WatermarkStyle`；`getAppSettings` 缺省值、`updateAppSettings` 写 `watermark_style` 键
  - 导出 `DEFAULT_WATERMARK_STYLE` 与 `WatermarkStyle` 类型

### 2. 合成模块

- 新文件 `server/src/media/watermark.ts`：
  - `composeWatermarkText(prefix, userText)`：`·` 连接、空段过滤
  - `applyWatermark(buf, style, userText)`：全尺寸 SVG 文字层 + sharp composite + 显式 toFormat；空文字直接返回原 buffer
- 新文件 `server/tests/watermark.test.ts`：单元用例（尺寸不变、字节改变、空文字透传、样式参数生效）

### 3. 路由

- 新文件 `server/src/server/downloads.ts`：`registerDownloads(ctx)`
  - `GET /v1/download/:name`（requireUser）：NAME_RE 校验 → 读文件 → 按配置合成 → attachment 返回（no-store）
  - `GET/PUT /v1/watermark`（requireUser）：校验 enabled 布尔、text ≤60 字
- `server/src/app.ts`：注册 `registerDownloads`
- `server/src/server/settings.ts`：PUT `/admin/settings` 增加可选 `watermarkStyle` 校验（position 枚举、fontSize 12–128 整数、opacity 0.1–1、color 十六进制、prefix ≤40 字）

### 4. Docker 字体

- `Dockerfile` runtime 阶段：`RUN apk add --no-cache fontconfig font-noto-cjk`
- `Dockerfile.ci`：头部注释说明 CI 镜像需自行保证 CJK 字体

### 5. 前端

- `web/src/api.ts`：类型 + `fetchMyWatermark` / `saveMyWatermark` / `downloadImage`
- `web/src/App.tsx`：menubar「水印」按钮 + FormDialog（启用开关 + 署名文字，打开时加载、保存后提示）
- `web/src/pages/Playground.tsx` / `web/src/pages/History.tsx`：下载按钮改 `downloadImage()`
- `web/src/pages/admin/SettingsTab.tsx`：「水印样式」区块并入保存流程
- `web/src/api.test.ts`：`downloadImage` 用例（/files URL 带 JWT、非 /files 回退）

### 6. 验证

- `npm test`（server + web）与 `npm run build` 全绿
- 手动：管理员样式 + 用户署名 → 下载带水印；关闭后逐字节一致；`/files/*` 与 API 返回无水印

## 验收清单

- [ ] 下载副本含水印且样式与管理员配置一致
- [ ] 关闭水印下载结果与原图逐字节一致
- [ ] 原文件、`/files/*`、API 返回始终无水印
- [ ] 管理员改样式即时影响所有启用用户
- [ ] 非法输入（超长文字、非法样式）返回 400
- [ ] Dockerfile 含 CJK 字体安装
