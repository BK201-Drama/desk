import { useEffect } from "react";
import type { PluginComponentProps } from "../../host/types";
import { useCursorUsage } from "./useCursor";
import { barWidth, formatUsedPct, toneFor } from "./model";
import "./panel.css";

function UsageRow({ title, used }: { title: string; used: number }) {
  const w = barWidth(used);
  return (
    <div className="tc-row">
      <div className="tc-row-top">
        <span className="tc-row-title">{title}</span>
        <span className="tc-row-pct">{formatUsedPct(used)}</span>
      </div>
      <div className="tc-bar" aria-hidden="true">
        <div className="tc-bar-fill" style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

export function TokenCapsulePanel({ ctx }: PluginComponentProps) {
  const { usage } = useCursorUsage(ctx);
  const tone = toneFor(usage);

  useEffect(() => {
    return ctx.registerCommand({
      id: "open-usage",
      title: "打开 Cursor Usage",
      group: "Cursor",
      run: () => void ctx.openUrl("https://cursor.com/dashboard?tab=usage"),
    });
  }, [ctx]);

  return (
    <button
      type="button"
      className={`tc-card tone-${tone}${usage.hitLimit ? " is-limit" : ""}`}
      data-testid="token-capsule-panel"
      title="打开 Cursor Usage"
      onClick={() => void ctx.openUrl("https://cursor.com/dashboard?tab=usage")}
    >
      {!usage.ok ? (
        <div className="tc-error">{usage.hint || "无法读取用量"}</div>
      ) : (
        <>
          <UsageRow
            title="Cursor Models"
            used={usage.autoPctUsed || usage.usedPct}
          />
          <UsageRow title="Other Models" used={usage.apiPctUsed} />
        </>
      )}
    </button>
  );
}

export default TokenCapsulePanel;
