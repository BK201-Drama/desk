import { useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { HostContext } from "../../host/types";

/** application：统一键盘输入开关 + 窗口聚焦 */
export function useKeyboardInput(ctx: HostContext | null | undefined) {
  return useCallback(
    async (active: boolean) => {
      if (!ctx) return;
      try {
        await ctx.invoke("set_keyboard_input", { active });
        if (active) await getCurrentWindow().setFocus();
      } catch (e) {
        console.warn("set_keyboard_input", e);
      }
    },
    [ctx]
  );
}
