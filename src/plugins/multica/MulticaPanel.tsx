import { useEffect, useRef } from "react";
import type { PluginComponentProps } from "../../host/types";
import { multicaIssueUrl } from "./model";
import { useMulticaSnapshot } from "./useMultica";
import { setSyncStatus } from "../../host/util";

export function MulticaPanel({ ctx }: PluginComponentProps) {
  const { snap, errorText, refresh, openBoard } = useMulticaSnapshot(ctx);
  const hintRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const unsubs = [
      ctx.registerCommand({
        id: "sync",
        title: "同步 Multica",
        group: "Multica",
        run: () => void refresh(),
      }),
      ctx.registerCommand({
        id: "open",
        title: "打开 Multica 看板",
        group: "Multica",
        run: () => void openBoard(),
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [ctx, refresh, openBoard]);

  useEffect(() => {
    if (!hintRef.current || !snap) return;
    setSyncStatus(hintRef.current, Date.now(), !errorText, snap.cached, snap.error);
  }, [snap, errorText]);

  return (
    <div className="mc" data-testid="multica-panel">
      <div className="mc-stats">
        <span className="mc-pill warn">
          <strong>{snap ? snap.inbox : "—"}</strong> inbox
        </span>
        <span className="mc-pill go">
          <strong>{snap ? snap.doing : "—"}</strong> doing
        </span>
        <span className="mc-pill">
          <strong>{snap ? snap.review : "—"}</strong> review
        </span>
        <button
          type="button"
          className="mc-open-icon"
          title="打开 Multica 看板"
          aria-label="打开 Multica 看板"
          onClick={() => void openBoard()}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M6.5 3.5H4.2A1.2 1.2 0 0 0 3 4.7v7.1c0 .66.54 1.2 1.2 1.2h7.1c.66 0 1.2-.54 1.2-1.2V9.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path
              d="M9 3.5h3.5V7M12.5 3.5 8 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div className="mc-list">
        {errorText ? (
          <div className="mc-row">
            <span className="title">Multica 未接通：{errorText}</span>
          </div>
        ) : !snap || snap.issues.length === 0 ? (
          <div className="mc-row">
            <span className="title" style={{ opacity: 0.55 }}>
              暂无进行中的 issue
            </span>
          </div>
        ) : (
          snap.issues.map((i) => {
            const url = multicaIssueUrl(snap.app_url, i.id);
            return (
              <div
                key={i.id || i.title}
                className={`mc-row${url ? " mc-link" : ""}`}
                title={url ? "打开 issue" : ""}
                onClick={() => {
                  if (url) void ctx.openUrl(url);
                }}
              >
                <span className={`st ${i.st}`}>{i.st}</span>
                <span className="title">{i.title}</span>
                <span className="who">{i.who}</span>
              </div>
            );
          })
        )}
      </div>
      <div className="mc-foot">
        <span className={`live${snap && !snap.runtime_online ? " off" : ""}`}>
          {snap ? (snap.runtime_online ? "runtime online" : "runtime offline") : "runtime …"}
        </span>
        <span ref={hintRef} title={snap?.error ?? undefined}>
          本地实例
        </span>
      </div>
    </div>
  );
}

export default MulticaPanel;
