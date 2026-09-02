// Playground 参数预设：仅存浏览器 localStorage，含模型、数量、尺寸、response_format 与高级参数
export interface PresetParams {
  model?: string;
  n?: number;
  size?: string;
  responseFormat?: string;
  extra?: string;
}

export interface Preset {
  id: string;
  name: string;
  params: PresetParams;
}

export const PRESETS_KEY = "tiny-playground-presets";
export const PRESET_NAME_MAX = 40;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadPresets(storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage): Preset[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PRESETS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is Preset => {
        const item = p as Partial<Preset> | null;
        return !!item && typeof item.id === "string" && typeof item.name === "string" && typeof item.params === "object" && item.params !== null;
      })
      .map((p) => ({ id: p.id, name: p.name, params: { ...p.params } }));
  } catch {
    return [];
  }
}

export function savePresets(presets: Preset[], storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage): void {
  if (!storage) return;
  storage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

export function createPreset(name: string, params: PresetParams, id: string = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`): Preset {
  return { id, name: name.trim().slice(0, PRESET_NAME_MAX) || "未命名预设", params: { ...params } };
}

export function newPresetId(): string {
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
