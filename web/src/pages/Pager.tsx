import { useEffect, useState } from "react";

// 客户端分页：数据变化（增删后刷新）时把页码收敛回有效范围。
export function usePager<T>(items: T[], pageSize: number) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount);
  useEffect(() => {
    setPage((cur) => Math.min(cur, pageCount));
  }, [pageCount]);
  return {
    page: safePage,
    pageCount,
    total: items.length,
    slice: items.slice((safePage - 1) * pageSize, safePage * pageSize),
    setPage,
  };
}

export function Pager(props: { page: number; pageCount: number; total: number; label: string; onPage: (page: number) => void }) {
  const { page, pageCount, total, label, onPage } = props;
  if (pageCount <= 1) return null;
  return (
    <div className="pager" role="navigation" aria-label={`${label}分页`}>
      <button className="btn small" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        « 上一页
      </button>
      <span className="muted mono">
        第 {page} / {pageCount} 页 · 共 {total} 条
      </span>
      <button className="btn small" type="button" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
        下一页 »
      </button>
    </div>
  );
}
