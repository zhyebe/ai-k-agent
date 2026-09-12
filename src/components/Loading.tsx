import { useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { getPendingRequests, subscribeRequests } from "../lib/api";
import "./loading.css";

export function BusyIcon({ busy = false, children }: { busy?: boolean; children: ReactNode }) {
  return busy ? <LoaderCircle className="loading-spinner" size={15} aria-hidden="true" /> : children;
}

export function RequestProgress() {
  const pending = useSyncExternalStore(subscribeRequests, getPendingRequests);
  return pending > 0 ? <div className="request-progress" role="progressbar" aria-label="请求处理中"><span /></div> : null;
}

export function LoadingStatus({ label }: { label: string }) {
  return <div className="loading-status" role="status"><LoaderCircle className="loading-spinner" size={17} aria-hidden="true" /><span>{label}</span></div>;
}

export function DataSkeleton({ label, layout = "list" }: { label: string; layout?: "dashboard" | "list" | "output" }) {
  return <div className={`data-skeleton skeleton-${layout}`} aria-busy="true">
    <LoadingStatus label={label} />
    <div className="skeleton-content" aria-hidden="true">
      {layout !== "output" && <div className="skeleton-heading"><span className="skeleton-block skeleton-title" /><span className="skeleton-block skeleton-subtitle" /></div>}
      {layout === "dashboard" && <div className="skeleton-metrics">{Array.from({ length: 4 }, (_, index) => <div className="skeleton-metric" key={index}><span className="skeleton-block" /><span className="skeleton-block skeleton-value" /><span className="skeleton-block" /></div>)}</div>}
      <div className="skeleton-rows">{Array.from({ length: layout === "output" ? 5 : 6 }, (_, index) => <div className="skeleton-row" key={index}><span className="skeleton-block skeleton-icon" /><div><span className="skeleton-block" /><span className="skeleton-block skeleton-detail" /></div><span className="skeleton-block skeleton-tail" /></div>)}</div>
    </div>
  </div>;
}

export function LoadError({ title, message, busy = false, onRetry }: { title: string; message: string; busy?: boolean; onRetry: () => void }) {
  return <div className="data-load-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><div><strong>{title}</strong><span>{message}</span></div><button type="button" className="button button-small button-secondary" disabled={busy} onClick={onRetry}><BusyIcon busy={busy}><RefreshCw size={14} /></BusyIcon>{busy ? "重试中" : "重新加载"}</button></div>;
}
