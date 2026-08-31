import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SettingsTab from "./SettingsTab";

describe("SettingsTab", () => {
  it("uses the existing admin form vocabulary for both settings", () => {
    const html = renderToStaticMarkup(<SettingsTab />);

    expect(html).toContain("全局提示词");
    expect(html).toContain("公告");
    expect(html).toContain("保存设置");
    expect(html).toContain('class="card"');
    expect(html).toContain('class="inline-form"');
  });
});
