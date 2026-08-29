import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { DeskHostBridge } from "../bootstrap";

type DeskShellValue = {
  bridge: DeskHostBridge;
  openCmdk: () => void;
  focusFenceSearch: () => void;
  registerOpenCmdk: (fn: (() => void) | null) => void;
  registerFocusFenceSearch: (fn: (() => void) | null) => void;
};

const DeskShellContext = createContext<DeskShellValue | null>(null);

export function DeskShellProvider({
  bridge,
  children,
}: {
  bridge: DeskHostBridge;
  children: ReactNode;
}) {
  const openCmdkRef = useRef<(() => void) | null>(null);
  const focusFenceRef = useRef<(() => void) | null>(null);

  const registerOpenCmdk = useCallback((fn: (() => void) | null) => {
    openCmdkRef.current = fn;
  }, []);

  const registerFocusFenceSearch = useCallback((fn: (() => void) | null) => {
    focusFenceRef.current = fn;
  }, []);

  const value = useMemo<DeskShellValue>(
    () => ({
      bridge,
      openCmdk: () => openCmdkRef.current?.(),
      focusFenceSearch: () => focusFenceRef.current?.(),
      registerOpenCmdk,
      registerFocusFenceSearch,
    }),
    [bridge, registerOpenCmdk, registerFocusFenceSearch]
  );

  return (
    <DeskShellContext.Provider value={value}>{children}</DeskShellContext.Provider>
  );
}

export function useDeskShell(): DeskShellValue {
  const ctx = useContext(DeskShellContext);
  if (!ctx) throw new Error("useDeskShell must be used within DeskShellProvider");
  return ctx;
}

export function useDeskShellOptional(): DeskShellValue | null {
  return useContext(DeskShellContext);
}

/** @deprecated 用 useDeskShell / useDeskShellOptional */
export function useDeskBridgeOptional(): DeskHostBridge | undefined {
  return useContext(DeskShellContext)?.bridge;
}
