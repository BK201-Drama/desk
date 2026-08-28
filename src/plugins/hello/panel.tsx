import type { PluginModule } from "../../host/types";
import HelloPanel from "../../features/hello/HelloPanel";

const panel: PluginModule = {
  Component: HelloPanel,
};

export default panel;
