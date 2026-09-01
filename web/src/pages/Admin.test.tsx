import { describe, expect, it } from "vitest";
import * as AdminModule from "./Admin";
import type { Channel } from "../api";

describe("channel type form state", () => {
  it("creates OpenAI-compatible channel drafts", () => {
    expect(AdminModule).toHaveProperty("newChannelDraft");
    expect((AdminModule.newChannelDraft as () => Partial<Channel>)()).toMatchObject({
      type: "openai-compat",
      editMode: "auto",
      timeoutMs: 120000,
      concurrency: 2,
      enabled: true,
    });
  });

  it("defaults only a new blank AI Horde draft URL", () => {
    expect(AdminModule).toHaveProperty("changeChannelType");
    const change = AdminModule.changeChannelType as (draft: Partial<Channel>, type: Channel["type"]) => Partial<Channel>;
    expect(change({ type: "openai-compat", baseUrl: "" }, "ai-horde").baseUrl).toBe("https://aihorde.net/api/v2");
    expect(change({ id: 7, type: "openai-compat", baseUrl: "https://custom.test" }, "ai-horde").baseUrl).toBe("https://custom.test");
  });
});
