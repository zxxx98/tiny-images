# Playground Textarea Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict the Playground Prompt and advanced JSON textareas to vertical-only resizing so their width stays inside the existing workspace grid.

**Architecture:** Scope one CSS rule to the Playground generation form with a dedicated class. Both existing textareas inherit the rule without changing their markup behavior, initial sizes, draft persistence, or submission logic; all other textareas remain governed by their existing styles.

**Tech Stack:** React 18, TypeScript, CSS, Vitest with jsdom, Vite

---

## File map

- Create `web/src/pages/PlaygroundResize.test.tsx`: render the Playground form with its stylesheet and verify both textareas compute to vertical-only resizing.
- Modify `web/src/pages/Playground.tsx`: add the CSS scope class to the existing generation form.
- Modify `web/src/styles.css`: define the scoped `resize: vertical` rule.

### Task 1: Add the failing resize regression test

**Files:**
- Create: `web/src/pages/PlaygroundResize.test.tsx`

- [ ] **Step 1: Write the failing test**

Create the test with jsdom, render the existing Playground through `MemoryRouter`, inject the stylesheet as a raw string, and assert that both form textareas compute to `vertical`:

```tsx
/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import Playground from "./Playground";
import styles from "../styles.css?raw";

const mounted: HTMLElement[] = [];
const styleElements: HTMLStyleElement[] = [];

afterEach(() => {
  mounted.splice(0).forEach((element) => element.remove());
  styleElements.splice(0).forEach((element) => element.remove());
});

describe("Playground textarea resizing", () => {
  it("allows vertical resizing for both prompt textareas", () => {
    const style = document.createElement("style");
    style.textContent = styles;
    document.head.append(style);
    styleElements.push(style);

    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <MemoryRouter>
        <Playground />
      </MemoryRouter>,
    );
    document.body.append(container);
    mounted.push(container);

    const textareas = container.querySelectorAll<HTMLTextAreaElement>("form.playground-form textarea");
    expect(textareas).toHaveLength(2);
    expect(Array.from(textareas).map((textarea) => getComputedStyle(textarea).getPropertyValue("resize"))).toEqual([
      "vertical",
      "vertical",
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing behavior**

Run:

```bash
npm test -w web -- src/pages/PlaygroundResize.test.tsx
```

Expected: Vitest reports one failed test because the current form has no `playground-form` scope and no `resize: vertical` rule, so the selector finds zero textareas instead of two.

### Task 2: Add the scoped vertical-only resize behavior

**Files:**
- Modify: `web/src/pages/Playground.tsx:326`
- Modify: `web/src/styles.css:338-349`

- [ ] **Step 1: Mark only the Playground generation form**

Change the existing form class from:

```tsx
<form className="card" onSubmit={run}>
```

to:

```tsx
<form className="card playground-form" onSubmit={run}>
```

- [ ] **Step 2: Set vertical-only resizing for textareas inside that form**

Add this rule immediately after the shared `input, select, textarea` form-control rule in `web/src/styles.css`:

```css
.playground-form textarea {
  resize: vertical;
}
```

This keeps the width controlled by the form grid while preserving native height dragging for both the main Prompt and advanced JSON fields. Do not add `resize` to the global `textarea` rule.

- [ ] **Step 3: Run the focused test and verify it passes**

Run:

```bash
npm test -w web -- src/pages/PlaygroundResize.test.tsx
```

Expected: Vitest reports the focused test passing with two textareas found and both computed `resize` values equal to `vertical`.

### Task 3: Run the complete frontend verification

**Files:**
- Verify: `web/src/pages/PlaygroundResize.test.tsx`
- Verify: `web/src/pages/Playground.tsx`
- Verify: `web/src/styles.css`

- [ ] **Step 1: Run all frontend tests**

Run:

```bash
npm test -w web
```

Expected: Vitest exits with code 0 and reports zero failed tests, including the new Playground resize regression test.

- [ ] **Step 2: Run the frontend production build**

Run:

```bash
npm run build -w web
```

Expected: TypeScript compilation and Vite production bundling both exit with code 0.

- [ ] **Step 3: Check the final diff for whitespace errors**

Run:

```bash
git diff --check
```

Expected: the command prints no diagnostics and exits with code 0.

- [ ] **Step 4: Commit the implementation**

Run:

```bash
git add web/src/pages/PlaygroundResize.test.tsx web/src/pages/Playground.tsx web/src/styles.css
git commit -m "fix(web): constrain playground textarea resizing"
```

The commit should contain only the scoped Playground class, the vertical resize CSS rule, and its regression test.
