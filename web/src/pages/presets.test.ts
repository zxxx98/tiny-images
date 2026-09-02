import { describe, expect, it } from "vitest";
import { createPreset, loadPresets, PRESETS_KEY, savePresets, type Preset } from "./presets";

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("presets store helpers", () => {
  it("round-trips presets through storage", () => {
    const storage = memoryStorage();
    const list = [
      createPreset("人像 1024", { model: "gpt-image-1", n: 2, size: "1024x1024", responseFormat: "url", extra: '{"quality":"high"}' }, "p-1"),
      createPreset("横版", { model: "flux", size: "1792x1024" }, "p-2"),
    ];
    savePresets(list, storage);
    expect(loadPresets(storage)).toEqual(list);
    expect(JSON.parse(storage.getItem(PRESETS_KEY)!).length).toBe(2);
  });

  it("returns an empty list on missing or corrupt data", () => {
    expect(loadPresets(memoryStorage())).toEqual([]);
    expect(loadPresets(memoryStorage({ [PRESETS_KEY]: "not json" }))).toEqual([]);
    expect(loadPresets(memoryStorage({ [PRESETS_KEY]: JSON.stringify({ nope: 1 }) }))).toEqual([]);
    expect(loadPresets(memoryStorage({ [PRESETS_KEY]: JSON.stringify([null, 3, { id: "p-9" }]) }))).toEqual([]);
  });

  it("returns nothing without storage", () => {
    expect(loadPresets(null)).toEqual([]);
    expect(() => savePresets([{ id: "p", name: "n", params: {} }], null)).not.toThrow();
  });

  it("trims the name, caps its length and falls back to a default", () => {
    expect(createPreset("  portrait  ", {}).name).toBe("portrait");
    expect(createPreset("x".repeat(80), {}).name.length).toBeLessThanOrEqual(40);
    expect(createPreset("   ", {}).name).toBe("未命名预设");
    const p: Preset = createPreset("a", { n: 3 }, "fixed-id");
    expect(p.id).toBe("fixed-id");
  });
});
