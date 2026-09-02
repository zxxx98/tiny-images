import { useEffect } from "react";

interface LightboxProps {
  src: string;
  alt?: string;
  caption?: string;
  onClose: () => void;
}

// 全屏灯箱：点击任意处或按 Esc 关闭。作为浮层使用，需自行阻止事件冒泡到下层弹窗。
export default function Lightbox({ src, alt, caption, onClose }: LightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="查看大图"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <img src={src} alt={alt ?? ""} />
      {caption && <p>{caption}</p>}
    </div>
  );
}
