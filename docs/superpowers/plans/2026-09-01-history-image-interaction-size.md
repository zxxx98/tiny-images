# 历史图片交互与尺寸展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复历史详情图片误进入 Playground 的点击行为，并在历史墙和详情元信息中显示图片请求尺寸。

**Architecture:** 保留历史墙块打开详情的现有流程，将详情图片改为纯展示；现有“编辑此图”按钮继续负责导航到 Playground。前端从已返回的历史 `params` 派生尺寸：普通记录使用 `size`，超分记录使用 `targetWidth`/`targetHeight`，缺失时回退为 `auto`，不改服务端数据结构。

**Tech Stack:** React 18、React Router 7、TypeScript、Vitest、Vite。

---

## 文件职责

- `web/src/pages/History.tsx`：历史记录数据形状、尺寸格式化、墙砖和详情的交互与展示。
- `web/src/pages/History.test.tsx`：历史图片点击导航回归测试、尺寸展示回归测试。
- `web/src/styles.css`：墙砖尺寸辅助文本样式，并移除已不再适用的图片可点击样式。

## Task 1: 先建立红色回归测试

**Files:**

- Modify: `web/src/pages/History.test.tsx`

- [ ] **Step 1: 扩展测试数据并写交互测试**

在 `upscaleItem.params` 中加入 `targetWidth: 2048` 和 `targetHeight: 1536`，并增加普通历史记录：

```tsx
const regularItem = {
  id: 8,
  createdAt: 2,
  model: "img-1",
  prompt: "a cat",
  params: { size: "1024x1536" },
  status: "ok" as const,
  latencyMs: 120,
  errorMessage: null,
  images: [{ file: "cat.png", url: "/files/cat.png" }],
};
```

追加测试，先点击墙砖打开详情，再点击图片；图片点击不应离开历史页。随后点击明确的编辑按钮，验证原有导航仍然工作：

```tsx
it("keeps the detail open when clicking a history image and navigates only from edit action", async () => {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/history"]}>
        <Routes>
          <Route path="/history" element={<History />} />
          <Route path="/" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
  });

  const tile = container.querySelector(".wall-tile") as HTMLButtonElement;
  await act(async () => tile.click());
  const image = container.querySelector(".detail-gallery img") as HTMLImageElement;
  await act(async () => image.click());

  expect(container.querySelector(".detail-overlay")).not.toBeNull();
  expect(container.querySelector('[data-testid="location-state"]')).toBeNull();

  const edit = Array.from(container.querySelectorAll(".shot-actions button")).find((item) => item.textContent?.trim() === "编辑此图") as HTMLButtonElement;
  await act(async () => {
    edit.click();
    await flush();
  });
  expect(container.querySelector('[data-testid="location-state"]')?.textContent).toBe('{"editImageUrl":"/files/upscaled.webp"}');
});
```

- [ ] **Step 2: 写尺寸展示测试**

追加测试，覆盖普通请求尺寸、缺省尺寸、超分目标尺寸在墙砖与详情中的显示：

```tsx
it("shows normal, fallback, and upscale output sizes in history", async () => {
  vi.mocked(apiModule.api).mockResolvedValue({
    items: [
      regularItem,
      { ...upscaleItem, id: 9, params: { operation: "upscale", scale: 2, targetWidth: 2048, targetHeight: 1536 } },
      { ...regularItem, id: 10, params: {} },
    ],
  } as never);

  await act(async () => {
    root.render(<MemoryRouter initialEntries={["/history"]}><History /></MemoryRouter>);
    await flush();
  });

  expect(container.textContent).toContain("尺寸: 1024x1536");
  expect(container.textContent).toContain("尺寸: 2048x1536");
  expect(container.textContent).toContain("尺寸: auto");

  const tile = container.querySelector('.wall-tile[title="a cat"]') as HTMLButtonElement;
  await act(async () => tile.click());
  expect(container.querySelector(".history-meta")?.textContent).toContain("尺寸: 1024x1536");
});
```

- [ ] **Step 3: 运行指定测试确认它们以预期原因失败**

Run from the worktree:

```bash
cd web && npx vitest run src/pages/History.test.tsx
```

Expected: the interaction test fails because the current image handler navigates to `/`, and the size test fails because no size element is rendered. Existing tests may still pass; do not change production code before observing this red state.

- [ ] **Step 4: Commit the red tests**

```bash
git add web/src/pages/History.test.tsx
git commit -m "test(web): cover history image clicks and sizes"
```

## Task 2: 实现最小修复并让测试变绿

**Files:**

- Modify: `web/src/pages/History.tsx`
- Modify: `web/src/styles.css`
- Test: `web/src/pages/History.test.tsx`

- [ ] **Step 1: 扩展历史参数类型并增加尺寸格式化函数**

在 `HistoryParams` 中加入尺寸字段，并在 `historyItemLabel` 后增加：

```tsx
interface HistoryParams {
  operation?: "upscale" | string;
  scale?: number;
  size?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  targetWidth?: number;
  targetHeight?: number;
  [key: string]: unknown;
}

export function historyItemSize(item: Pick<HistoryItem, "params">): string {
  const params = item.params;
  if (
    params?.operation === "upscale" &&
    Number.isInteger(params.targetWidth) &&
    params.targetWidth > 0 &&
    Number.isInteger(params.targetHeight) &&
    params.targetHeight > 0
  ) {
    return `${params.targetWidth}x${params.targetHeight}`;
  }
  return typeof params?.size === "string" && params.size.length > 0 ? params.size : "auto";
}
```

- [ ] **Step 2: 让历史图片只通过显式按钮进入 Playground**

在详情图片元素上移除 `title="点击进入图片编辑"` 与 `onClick={() => editImage(img.url)}`，保留 `src`、`alt`、`loading` 和 `onError`；保留旁边现有的“编辑此图”按钮及其 `onClick`。删除 `styles.css` 中 `.shot img { cursor: pointer; }`，避免纯展示图片仍呈现可点击提示。

- [ ] **Step 3: 在墙砖和详情元信息渲染尺寸**

在 `items.map` 中计算尺寸并在 caption 后显示：

```tsx
const label = historyItemLabel(item);
const size = historyItemSize(item);
```

```tsx
<span className="wall-caption">{label}</span>
<span className="wall-size muted">尺寸: {size}</span>
```

在详情 `.history-meta` 中加入：

```tsx
<span className="pill">尺寸: {historyItemSize(detail)}</span>
```

在 `styles.css` 增加：

```css
.wall-size {
  font-size: 11px;
  line-height: 1.3;
  word-break: break-all;
}
```

- [ ] **Step 4: 运行 web 测试确认变绿**

```bash
cd web && npx vitest run src/pages/History.test.tsx
```

Expected: `History.test.tsx` 的全部测试通过。

- [ ] **Step 5: 运行 web 全量测试并提交实现**

```bash
npm test -w web
```

Expected: web 测试文件全部通过，随后执行：

```bash
git add web/src/pages/History.tsx web/src/styles.css web/src/pages/History.test.tsx
git commit -m "fix(web): keep history previews in place and show sizes"
```

## Task 3: 集成前验收

- [ ] **Step 1: 检查变更与格式**

```bash
git diff --check HEAD~1..HEAD
git status --short
```

Expected: no whitespace errors；worktree 只包含本任务已提交内容。

- [ ] **Step 2: 运行完整测试套件**

```bash
npm test
```

Expected: server 与 web 均以退出码 0 完成，失败数为 0。

- [ ] **Step 3: 运行生产构建**

```bash
npm run build
```

Expected: web TypeScript 检查与 Vite 构建、server TypeScript 构建全部以退出码 0 完成。

- [ ] **Step 4: 查看最终差异并准备合并**

```bash
git log --oneline --decorate -4
git diff main...HEAD --stat
git status --short --branch
```

确认两个用户需求均有对应实现和测试后，使用 `finishing-a-development-branch` 流程在主 worktree 拉取最新 `main`、合并本分支、在合并结果上再次运行 `npm test`，再提交合并结果并推送 `main`。
