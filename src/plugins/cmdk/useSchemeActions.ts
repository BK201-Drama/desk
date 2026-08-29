import { useCallback } from "react";
import { useDeskBridgeOptional } from "../../app/providers/DeskBridgeProvider";
import { useLayoutConfig } from "./useLayoutConfig";
import {
  activeScheme,
  hasSchemeDraft,
  isBuiltinPreset,
  MAX_SCHEMES,
  PRESET_LABEL,
} from "../../host/schemeLogic";
import { enabledIds, schemeEnabledIds } from "../../host/layout-util";
import { showToast } from "../../host/toast";
import type { PluginsConfig } from "../../host/types";

/** application 层：方案 CRUD，封装 host 桥接 */
export function useSchemeActions() {
  const bridge = useDeskBridgeOptional();
  const { config, refresh } = useLayoutConfig();

  const applyPresetId = useCallback(
    async (id: string) => {
      if (id.startsWith("scheme:")) {
        await bridge?.applyScheme?.(id.slice("scheme:".length));
      } else {
        await bridge?.applyPreset?.(id);
      }
      await refresh();
      showToast(`已切到${PRESET_LABEL[id] ?? id.replace(/^scheme:/, "")}`);
    },
    [bridge, refresh]
  );

  const applySchemeTab = useCallback(
    async (id: string) => {
      await bridge?.applyScheme?.(id);
      await refresh();
      const cfg = config;
      const name = cfg?.schemes?.find((s) => s.id === id)?.name ?? "方案";
      showToast(`已应用「${name}」`);
    },
    [bridge, config, refresh]
  );

  const createNewScheme = useCallback(
    async (name?: string) => {
      const count = config?.schemes?.length ?? 0;
      if (count >= MAX_SCHEMES) {
        alert(`最多 ${MAX_SCHEMES} 个方案，请先删除一个`);
        return;
      }
      await bridge?.createScheme?.(name);
      await refresh();
      showToast(`已新建方案（${count + 1}/${MAX_SCHEMES}）`);
    },
    [bridge, config, refresh]
  );

  const saveActiveScheme = useCallback(
    async (name?: string) => {
      const id = config?.active_scheme_id;
      if (id) {
        await bridge?.updateScheme?.(id, name);
        await refresh();
        showToast("方案已保存");
      } else if ((config?.schemes?.length ?? 0) < MAX_SCHEMES) {
        await bridge?.createScheme?.(name);
        await refresh();
        showToast("方案已保存");
      } else {
        alert(`最多 ${MAX_SCHEMES} 个方案，请选中一个后保存，或先删除`);
      }
    },
    [bridge, config, refresh]
  );

  const discardScheme = useCallback(async () => {
    const hadScheme = config?.active_scheme_id != null;
    await bridge?.discardDraft?.();
    await refresh();
    showToast(hadScheme ? "已恢复为上次保存的版本" : "已恢复为程序员布局");
  }, [bridge, config, refresh]);

  const deleteActiveScheme = useCallback(async () => {
    const id = config?.active_scheme_id;
    if (!id || !config) return;
    const name = config.schemes?.find((s) => s.id === id)?.name ?? "方案";
    if (!confirm(`删除方案「${name}」？`)) return;
    await bridge?.deleteScheme?.(id);
    await refresh();
    showToast(`已删除「${name}」`);
  }, [bridge, config, refresh]);

  return {
    config,
    applyPresetId,
    applySchemeTab,
    createNewScheme,
    saveActiveScheme,
    discardScheme,
    deleteActiveScheme,
  };
}

export type SchemeComposerView = {
  schemes: NonNullable<PluginsConfig["schemes"]>;
  count: number;
  activeId: string | null;
  draft: boolean;
  onScheme: boolean;
  currentBlocks: string[];
  savedBlocks: string[];
  schemeName: string;
  activePreset: string;
  canCreate: boolean;
};

export function buildSchemeComposerView(cfg: PluginsConfig | null): SchemeComposerView | null {
  if (!cfg) return null;
  const schemes = cfg.schemes ?? [];
  const current = activeScheme(cfg);
  return {
    schemes,
    count: schemes.length,
    activeId: cfg.active_scheme_id ?? null,
    draft: hasSchemeDraft(cfg),
    onScheme: cfg.active_preset === "scheme",
    currentBlocks: enabledIds(cfg),
    savedBlocks: current ? schemeEnabledIds(current) : [],
    schemeName: current?.name ?? "",
    activePreset: cfg.active_preset || "coder",
    canCreate: schemes.length < MAX_SCHEMES,
  };
}

export function isBuiltinActive(activePreset: string, presetId: string): boolean {
  return isBuiltinPreset(activePreset) && activePreset === presetId;
}
