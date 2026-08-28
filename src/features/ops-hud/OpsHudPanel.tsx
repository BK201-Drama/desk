import { useEffect, useState } from "react";
import type { PluginComponentProps } from "../../host/types";
import { listMounted } from "../../host/registry";
import { ageLabel, rpcLabel } from "../../domain/ops-hud";
import "../../plugins/ops-hud/panel.css";

export function OpsHudPanel({ ctx }: PluginComponentProps) {
  const [editing, setEditing] = useState(() => ctx.editing());
  const [pluginCount, setPluginCount] = useState(() => listMounted().length);
  const [lastOk, setLastOk] = useState<boolean | null>(null);
  const [ghAt, setGhAt] = useState<number | undefined>();
  const [mcAt, setMcAt] = useState<number | undefined>();
  const [, setTick] = useState(0);

  useEffect(() => {
    const el = document.querySelector('[data-plugin="ops-hud"]');
    el?.classList.add("ops-hud-host");

    const unsubs = [
      ctx.on("*", (ev) => {
        if (ev.type === "invoke:ok" || ev.type === "invoke:err") {
          const cmd = (ev.detail as { cmd?: string } | null)?.cmd;
          if (cmd === "set_cursor" || cmd === "set_keyboard_input") return;
          setLastOk(ev.type === "invoke:ok");
        }
        if (ev.type === "github:sync") setGhAt(ev.at);
        if (ev.type === "multica:sync") setMcAt(ev.at);
        if (
          ev.type === "plugin:ready" ||
          ev.type === "plugin:mounted" ||
          ev.type === "plugin:unmounted"
        ) {
          setPluginCount(listMounted().length);
        }
      }),
      ctx.onEditChange((on) => setEditing(on)),
    ];
    const timer = window.setInterval(() => {
      setPluginCount(listMounted().length);
      setEditing(ctx.editing());
      setTick((t) => t + 1);
    }, 2000);

    return () => {
      for (const u of unsubs) u();
      window.clearInterval(timer);
    };
  }, [ctx]);

  return (
    <div className="ops-hud" title="Ops · Ctrl+K 可关闭" data-testid="ops-hud">
      <span className={`seg${editing ? " on" : ""}`}>{editing ? "EDIT" : "live"}</span>
      <span className="seg">{pluginCount}p</span>
      <span className="seg">gh {ageLabel(ghAt)}</span>
      <span className="seg">mc {ageLabel(mcAt)}</span>
      <span className="seg rpc">{rpcLabel(lastOk)}</span>
    </div>
  );
}

export default OpsHudPanel;
