import { useEffect } from "react";
import type { PluginComponentProps, PluginModule } from "../../host/types";

function HelloPanel({ ctx }: PluginComponentProps) {
  useEffect(() => {
    ctx.emit("hello:ping", { source: "bundled" });
  }, [ctx]);

  return (
    <div
      className="hello-plugin"
      data-testid="hello-panel"
      style={{
        fontSize: 11,
        opacity: 0.7,
        padding: "6px 0",
        borderTop: "1px dashed rgba(26,35,50,.15)",
        marginTop: 6,
        fontFamily: "Cascadia Code, Consolas, monospace",
      }}
    >
      <span style={{ color: "#2d6a4f" }}>▸</span> bundled plugin <b>hello</b> online
    </div>
  );
}

const panel: PluginModule = {
  Component: HelloPanel,
};

export default panel;
