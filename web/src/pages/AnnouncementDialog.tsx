import type { Announcement } from "../api";

export const ANNOUNCEMENT_ACK_KEY = "tiny-announcement-version";

export const shouldShowAnnouncement = (value: Announcement, acknowledged: string | null): boolean =>
  value.announcement.length > 0 && acknowledged !== String(value.version);

export function persistAnnouncementAcknowledgement(
  value: Announcement,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(ANNOUNCEMENT_ACK_KEY, String(value.version));
}

export default function AnnouncementDialog({ value, onAcknowledge }: { value: Announcement; onAcknowledge: () => void }) {
  return (
    <div className="detail-overlay announcement-overlay" role="presentation">
      <section className="win-window announcement-window" role="dialog" aria-modal="true" aria-labelledby="announcement-title">
        <header className="titlebar">
          <span id="announcement-title">公告</span>
        </header>
        <div className="announcement-body">
          <p className="announcement-copy">{value.announcement}</p>
          <button className="btn primary" type="button" autoFocus onClick={onAcknowledge}>
            知道了
          </button>
        </div>
      </section>
    </div>
  );
}
