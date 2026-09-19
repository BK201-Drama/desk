import { useCallback, useEffect, useState } from "react";
import type { PluginComponentProps } from "../../host/types";
import "./panel.css";

type Status = { clutter: number; items: string[] };
type RunResult = { moved: number; dest: string };

function hoverText(items: string[]): string {
  if (items.length === 0) return "桌面没有待整理的 Word / Excel / PPT";
  const head = items.slice(0, 12).join("\n");
  const more = items.length > 12 ? `\n…还有 ${items.length - 12} 项` : "";
  return `将移入「桌面\\整理\\今天」：\n${head}${more}`;
}

function DeskTidyPanel({ ctx }: PluginComponentProps) {
  const [clutter, setClutter] = useState(0);
  const [items, setItems] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const st = await ctx.invoke<Status>("desk_tidy_status");
      setClutter(st.clutter);
      setItems(st.items ?? []);
      setMsg(null);
    } catch (e) {
      setMsg(String(e));
    }
  }, [ctx]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const runTidy = useCallback(async () => {
    if (clutter <= 0) {
      setMsg("没有可整理的文件");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await ctx.invoke<RunResult>("desk_tidy_run");
      await refresh();
      setMsg(r.moved > 0 ? `已整理 ${r.moved} 项` : "没有可整理的文件");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }, [clutter, ctx, refresh]);

  useEffect(() => {
    const unsubs = [
      ctx.registerCommand({
        id: "run",
        title: "整理桌面",
        group: "桌面",
        run: () => void runTidy(),
      }),
      ctx.registerCommand({
        id: "refresh",
        title: "刷新桌面脏度",
        group: "桌面",
        run: () => void refresh(),
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [ctx, refresh, runTidy]);

  const dirty = clutter > 0;
  const tip = hoverText(items);

  return (
    <div
      className={`dt-card${dirty ? " is-dirty" : ""}`}
      data-testid="desk-tidy-panel"
      title={tip}
    >
      <div className="dt-row">
        <div className="dt-text" title={tip}>
          <span className="dt-title">
            {dirty ? `${clutter} 份文档待整理` : "文档已归位"}
          </span>
          <span className="dt-meta">
            {dirty ? "Word/Excel/PPT · 悬停看清单" : "只收办公文档"}
          </span>
        </div>
        <button
          type="button"
          className="dt-btn"
          disabled={busy || !dirty}
          title={tip}
          onClick={() => void runTidy()}
        >
          {busy ? "…" : "整理"}
        </button>
      </div>
      {msg ? <p className="dt-msg">{msg}</p> : null}
    </div>
  );
}

export default DeskTidyPanel;
