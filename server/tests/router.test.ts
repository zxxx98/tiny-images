import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { ModelRouter } from "../src/core/router.js";

let repo: Repo;
let router: ModelRouter;
beforeEach(() => {
  repo = new Repo(openDb(fs.mkdtempSync(path.join(os.tmpdir(), "rt-"))));
  router = new ModelRouter(repo);
});

describe("ModelRouter", () => {
  it("resolves enabled model on enabled channel", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    repo.createModel({ publicName: "img", channelId: c.id, upstreamName: "up-1" });
    const r = router.resolve("img")!;
    expect(r.model.upstreamName).toBe("up-1");
    expect(r.channel.baseUrl).toBe("https://x/v1");
  });
  it("rejects disabled model / disabled channel / unknown model", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const m = repo.createModel({ publicName: "img", channelId: c.id });
    repo.updateModel(m.id, { enabled: false });
    expect(router.resolve("img")).toBeNull();
    repo.updateModel(m.id, { enabled: true });
    repo.updateChannel(c.id, { enabled: false });
    expect(router.resolve("img")).toBeNull();
    expect(router.resolve("nope")).toBeNull();
  });
});
