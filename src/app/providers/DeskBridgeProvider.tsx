import { createContext, useContext, type ReactNode } from "react";
import type { DeskHostBridge } from "../../app/bootstrap";

const DeskBridgeContext = createContext<DeskHostBridge | null>(null);

export function DeskBridgeProvider({
  bridge,
  children,
}: {
  bridge: DeskHostBridge;
  children: ReactNode;
}) {
  return (
    <DeskBridgeContext.Provider value={bridge}>{children}</DeskBridgeContext.Provider>
  );
}

export function useDeskBridge(): DeskHostBridge {
  const ctx = useContext(DeskBridgeContext);
  if (!ctx) {
    throw new Error("useDeskBridge must be used within DeskBridgeProvider");
  }
  return ctx;
}

/** 插件内：HostContext 环境可能没有 Provider，回退 window 桥接 */
export function useDeskBridgeOptional(): DeskHostBridge | undefined {
  const ctx = useContext(DeskBridgeContext);
  return ctx ?? window.__deskHost;
}
