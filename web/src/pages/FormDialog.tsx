import { ReactNode, useEffect, useRef } from "react";

interface FormDialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

// Win95 模态表单弹窗：标题栏 + × 关闭、Esc 关闭、打开时聚焦第一个字段。
// 遮罩点击不关闭，避免误触丢失正在编辑的表单内容。
export default function FormDialog({ title, onClose, children }: FormDialogProps) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea")?.focus();
  }, []);

  return (
    <div className="detail-overlay" role="presentation">
      <section ref={ref} className="win-window form-window" role="dialog" aria-modal="true" aria-label={title}>
        <header className="titlebar">
          <span>{title}</span>
          <span className="win-buttons">
            <span role="button" tabIndex={0} aria-label="关闭" onClick={onClose} onKeyDown={(e) => e.key === "Enter" && onClose()}>
              ×
            </span>
          </span>
        </header>
        <div className="form-dialog-body">{children}</div>
      </section>
    </div>
  );
}
