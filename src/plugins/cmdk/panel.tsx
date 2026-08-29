import type { PluginModule } from "../../host/types";
import CmdkPanel from "./CmdkPanel";

/** 插件入口：业务在同目录 */
const panel: PluginModule = {
  Component: CmdkPanel,
};

export default panel;
