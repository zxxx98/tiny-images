import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EditImageInput from "./EditImageInput";

const renderInput = (files: File[]): string =>
  renderToStaticMarkup(<EditImageInput files={files} previews={[]} onChange={() => undefined} />);

describe("EditImageInput", () => {
  it("requires a manual choice only when no image is already loaded", () => {
    expect(renderInput([])).toMatch(/<input[^>]+id="pg-edit-image"[^>]+required=""/);
    expect(renderInput([{ name: "existing.png" } as File])).not.toMatch(/id="pg-edit-image"[^>]+required=""/);
  });
});
