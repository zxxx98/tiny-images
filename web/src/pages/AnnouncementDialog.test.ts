import { describe, expect, it } from "vitest";
import { shouldShowAnnouncement } from "./AnnouncementDialog";

describe("shouldShowAnnouncement", () => {
  it("hides empty and acknowledged announcements", () => {
    expect(shouldShowAnnouncement({ announcement: "", version: 2 }, null)).toBe(false);
    expect(shouldShowAnnouncement({ announcement: "hello", version: 2 }, "2")).toBe(false);
  });

  it("shows unacknowledged and changed announcements", () => {
    expect(shouldShowAnnouncement({ announcement: "hello", version: 2 }, null)).toBe(true);
    expect(shouldShowAnnouncement({ announcement: "changed", version: 3 }, "2")).toBe(true);
  });
});
