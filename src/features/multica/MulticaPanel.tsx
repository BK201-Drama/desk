import { useEffect, useRef } from "react";
import type { PluginComponentProps } from "../../host/types";
import { multicaIssueUrl } from "../../domain/multica";
import { useMulticaSnapshot } from "../../application/multica/useMulticaSnapshot";
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
      <div className="mc-head">
        <span className="brand">Multica</span>
        <button type="button" className="mc-open" onClick={() => void openBoard()}>
          打开看板 →
        </button>
      </div>
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
