import { useEffect, useState } from "react";
import type { PluginComponentProps } from "../../host/types";
import {
  appendTapeLine,
  fmtTapeTime,
  isTapeNoise,
  summarizeTape,
  tapeHeadLabel,
  type TapeLine,
} from "./model";
import "./panel.css";

export function EventTapePanel({ ctx }: PluginComponentProps) {
  const [lines, setLines] = useState<TapeLine[]>([]);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    ctx.registerCommand({
      id: "toggle",
      title: "展开/收起 Event Tape",
      group: "Desk",
      run: () => setCollapsed((c) => !c),
    });
    const unsub = ctx.on("*", (ev) => {
      if (isTapeNoise(ev.type, ev.detail)) return;
      setLines((prev) =>
        appendTapeLine(prev, {
          at: ev.at,
          type: ev.type,
          source: ev.source,
          text: summarizeTape(ev.type, ev.detail),
        })
      );
    });
    return () => unsub();
  }, [ctx]);

  const visible = collapsed ? [] : lines.slice(-24).reverse();

  return (
    <div
      className={`event-tape${collapsed ? " collapsed" : ""}`}
      data-testid="event-tape"
    >
      <button
        type="button"
        className="event-tape-head"
        title="展开/收起事件流"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span>{tapeHeadLabel(collapsed, lines)}</span>
        <kbd>{collapsed ? "▸" : "▾"}</kbd>
      </button>
      <div className="event-tape-body">
        {visible.map((l) => (
          <div key={`${l.at}-${l.type}-${l.text}`} className="event-tape-line">
            <span className="t">{fmtTapeTime(l.at)}</span>
            <span className="ty">{l.type}</span>
            <span className="tx">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default EventTapePanel;
