import { useEffect } from "react";
import type { PluginComponentProps } from "../../host/types";
import { difficultyLabel, problemUrl } from "./model";
import { useLeetCodeDaily } from "./useLeetCodeDaily";
import "./panel.css";

export function LeetCodeDailyPanel({ ctx }: PluginComponentProps) {
  const { daily, error, refresh } = useLeetCodeDaily(ctx);

  useEffect(() => {
    return ctx.registerCommand({
      id: "refresh",
      title: "刷新每日一题",
      group: "力扣",
      run: () => void refresh(),
    });
  }, [ctx, refresh]);

  const open = () => {
    if (!daily) return;
    void ctx.openUrl(problemUrl(daily.titleSlug));
  };

  return (
    <div className="lc-card" data-testid="leetcode-daily-panel">
      {error && !daily ? (
        <button type="button" className="lc-error" onClick={() => void refresh()}>
          {error}
        </button>
      ) : !daily ? (
        <div className="lc-empty">加载中…</div>
      ) : (
        <button type="button" className="lc-row" onClick={open} title="打开题目">
          <span className="lc-title" title={daily.titleCn}>
            {daily.frontendId ? `${daily.frontendId}. ` : ""}
            {daily.titleCn}
          </span>
          <span className={`lc-diff is-${daily.difficulty.toLowerCase()}`}>
            【{difficultyLabel(daily.difficulty)}】
          </span>
        </button>
      )}
    </div>
  );
}

export default LeetCodeDailyPanel;
