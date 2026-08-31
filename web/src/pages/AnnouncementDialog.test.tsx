/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import AnnouncementDialog, {
  ANNOUNCEMENT_ACK_KEY,
  persistAnnouncementAcknowledgement,
  shouldShowAnnouncement,
} from "./AnnouncementDialog";

describe("announcement acknowledgement", () => {
  it("hides empty and acknowledged announcements", () => {
    expect(shouldShowAnnouncement({ announcement: "", version: 2 }, null)).toBe(false);
    expect(shouldShowAnnouncement({ announcement: "hello", version: 2 }, "2")).toBe(false);
  });

  it("shows unacknowledged, whitespace, and changed announcements", () => {
    expect(shouldShowAnnouncement({ announcement: "hello", version: 2 }, null)).toBe(true);
    expect(shouldShowAnnouncement({ announcement: " ", version: 2 }, null)).toBe(true);
    expect(shouldShowAnnouncement({ announcement: "changed", version: 3 }, "2")).toBe(true);
  });

  it("persists the acknowledged version in browser storage", () => {
    const setItem = vi.fn();
    persistAnnouncementAcknowledgement({ announcement: "hello", version: 7 }, { setItem });
    expect(setItem).toHaveBeenCalledWith(ANNOUNCEMENT_ACK_KEY, "7");
  });

  it("renders preserved text, focuses the action, and acknowledges on click", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAcknowledge = vi.fn();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    await act(async () => {
      root.render(<AnnouncementDialog value={{ announcement: "line one\nline two", version: 2 }} onAcknowledge={onAcknowledge} />);
    });
    const button = container.querySelector("button")!;
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector(".announcement-copy")!.textContent).toBe("line one\nline two");
    expect(document.activeElement).toBe(button);

    await act(async () => button.click());
    expect(onAcknowledge).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    container.remove();
  });
});
