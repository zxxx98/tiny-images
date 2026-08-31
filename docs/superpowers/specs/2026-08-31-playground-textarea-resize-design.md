# Playground 文本框拉伸方向设计

## 目标

限制 Playground 中主 Prompt 和高级参数 JSON 两个 `textarea` 只能竖向拉伸，避免用户横向拉伸后输入框超出背景格和左侧工作区边界。其他页面的文本框行为保持不变。

## 方案

给 Playground 的生成表单增加专用标识 class，并在 `web/src/styles.css` 中对该表单内的 `textarea` 设置 `resize: vertical`。浏览器继续负责原生拉伸交互：高度可以由用户调整，宽度保持由表单布局决定。

## 影响范围与行为

- `web/src/pages/Playground.tsx`：为包含两个文本框的表单增加专用 class。
- `web/src/styles.css`：增加局部规则，仅匹配 Playground 表单内的 `textarea`。
- 主 Prompt 与高级参数 JSON 均可竖向拉伸，不可横向拉伸。
- 其他页面和非 Playground 文本框不受影响。
- 不调整初始行数、表单布局、输入内容持久化或提交逻辑。

## 验证

增加/调整前端测试，确认 Playground 表单同时包含两个目标文本框，并通过样式规则将其 `resize` 设置为 `vertical`；同时检查生产构建，确保 TypeScript 和 Vite 构建通过。
