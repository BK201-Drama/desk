import { useEffect } from "react";
import type { PluginComponentProps, PluginModule } from "../../host/types";
import "./panel.css";

/**
 * L2 自包含示例：UI + 逻辑都在本目录，不要新建 domain/application/features。
 * 复制本文件夹为 `plugins/<id>/`，改 manifest.id 与目录名一致即可被 glob 发现。
 */
function MyPanel({ ctx }: PluginComponentProps) {
  useEffect(() => {
    ctx.emit("my-panel:ready");
    return ctx.registerCommand({
      id: "ping",
      title: "My Panel · Ping",
      group: "插件",
      run: () => ctx.emit("my-panel:ping"),
    });
  }, [ctx]);

  return (
    <div className="my-panel" data-testid="my-panel">
      <span className="my-panel-mark">▸</span> my-panel（模板）
    </div>
  );
}

const panel: PluginModule = {
  Component: MyPanel,
};

export default panel;
