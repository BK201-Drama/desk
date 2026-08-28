import type { PluginModule } from "../../host/types";
import CmdkPanel from "../../features/cmdk/CmdkPanel";

/** 插件入口：薄包装，业务在 features/cmdk */
const panel: PluginModule = {
  Component: CmdkPanel,
};

export default panel;
