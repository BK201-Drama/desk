import { useCallback, useEffect, useState } from "react";
import type { PluginsConfig, PresetInfo } from "../../host/types";
import { getConfig, listPresets } from "../../host/presets";
import { on } from "../../host/events";

/** application 层：布局配置读取与刷新，不含 UI */
export function useLayoutConfig() {
  const [config, setConfig] = useState<PluginsConfig | null>(null);
  const [presets, setPresets] = useState<PresetInfo[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [cfg, ps] = await Promise.all([getConfig(), listPresets()]);
      setConfig(cfg);
      setPresets(ps);
    } catch (e) {
      console.warn("useLayoutConfig.refresh", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubs = [
      on("plugin:ready", () => void refresh()),
      on("preset:applied", () => void refresh()),
      on("scheme:created", () => void refresh()),
      on("scheme:updated", () => void refresh()),
      on("scheme:deleted", () => void refresh()),
      on("preset:discarded-draft", () => void refresh()),
      on("plugin:order", () => void refresh()),
    ];
    return () => unsubs.forEach((u) => u());
  }, [refresh]);

  return { config, presets, refresh };
}
