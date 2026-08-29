import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type { PluginComponentProps } from "../../host/types";
import { listCommands } from "../../host/api";
import { toggleEditing } from "../../host/edit";
import { useDeskBridgeOptional } from "../../app/providers/DeskBridgeProvider";
import { useLayoutConfig } from "./useLayoutConfig";
import { clampSelected, collectCommands, collectNav } from "./navLogic";
import type { HostCommand } from "../../host/types";
import { CmdkList } from "./CmdkList";
import { SchemeComposer } from "./SchemeComposer";
import "../../plugins/cmdk/panel.css";

export function CmdkPanel({ ctx }: PluginComponentProps) {
  const bridge = useDeskBridgeOptional();
  const { config, presets, refresh } = useLayoutConfig();
  const [open, setOpenState] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const [optimisticDisabled, setOptimisticDisabled] = useState<Set<string> | null>(null);
  const togglingRef = useRef(false);
  const movingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  const hostEl = () =>
    shellRef.current?.closest<HTMLElement>('[data-plugin="cmdk"]') ?? null;

  const disabledIds = useMemo(
    () => optimisticDisabled ?? new Set(config?.disabled ?? []),
    [optimisticDisabled, config?.disabled]
  );

  useEffect(() => {
    setOptimisticDisabled(null);
  }, [config]);

  const setKeyboard = useCallback(
    async (active: boolean) => {
      try {
        await ctx.invoke("set_keyboard_input", { active });
        if (active) await getCurrentWindow().setFocus();
      } catch {
        /* ignore outside Tauri */
      }
    },
    [ctx]
  );

  const setOpen = useCallback(
    (next: boolean | ((was: boolean) => boolean)) => {
      setOpenState((was) => {
        const value = typeof next === "function" ? next(was) : next;
        hostEl()?.classList.toggle("show", value);
        if (value) {
          setFilter("");
          setSelected(0);
          void setKeyboard(true);
          void refresh();
          window.setTimeout(() => inputRef.current?.focus(), 30);
        } else {
          void setKeyboard(false);
        }
        return value;
      });
    },
    [refresh, setKeyboard]
  );

  const staticExtras = useMemo((): HostCommand[] => {
    const searching = filter.trim().length > 0;
    const extras: HostCommand[] = [
      {
        id: "host:toggle-edit",
        title: "切换编辑模式",
        hint: "Win+Shift+D",
        group: "Desk",
        run: () => toggleEditing(),
      },
    ];
    if (searching) {
      extras.push({
        id: "host:reload-plugins",
        title: "重载插件",
        group: "Desk",
        run: async () => {
          await bridge?.reloadPlugins?.();
          await refresh();
        },
      });
      extras.push({
        id: "host:focus-fence-search",
        title: "搜索桌面图标",
        hint: "/",
        group: "Desk",
        run: () => {
          window.__deskFocusFenceSearch?.();
        },
      });
      for (const p of presets) {
        const mark = p.id === "coder" ? " · 默认" : "";
        extras.push({
          id: `host:preset:${p.id}`,
          title: `${p.name}${mark}`,
          hint: p.description,
          group: "布局",
          run: async () => {
            await bridge?.applyPreset?.(p.id);
            await refresh();
          },
        });
      }
    }
    return extras;
  }, [bridge, filter, presets, refresh]);

  const commands = useMemo(() => {
    const searching = filter.trim().length > 0;
    return collectCommands(searching, staticExtras, listCommands());
  }, [filter, staticExtras]);

  const navItems = useMemo(
    () => collectNav(filter, disabledIds, commands),
    [filter, disabledIds, commands]
  );

  const safeSelected = clampSelected(selected, navItems.length);

  const movePlugin = useCallback(
    async (id: string, dir: -1 | 1) => {
      if (movingRef.current) return;
      movingRef.current = true;
      try {
        const fn = bridge?.movePlugin;
        if (!fn) throw new Error("movePlugin unavailable");
        await fn(id, dir);
        await refresh();
      } catch (e) {
        console.error(e);
        await refresh();
        alert(String(e));
      } finally {
        movingRef.current = false;
      }
    },
    [bridge, refresh]
  );

  const togglePlugin = useCallback(
    async (id: string, nextOn: boolean) => {
      if (togglingRef.current) return;
      togglingRef.current = true;
      try {
        setOptimisticDisabled((prev) => {
          const base = prev ?? new Set(config?.disabled ?? []);
          const next = new Set(base);
          if (nextOn) next.delete(id);
          else next.add(id);
          return next;
        });
        const enable = bridge?.setPluginEnabled;
        if (!enable) throw new Error("setPluginEnabled unavailable");
        await enable(id, nextOn);
        await refresh();
      } catch (e) {
        console.error(e);
        setOptimisticDisabled(null);
        await refresh();
        alert(String(e));
      } finally {
        togglingRef.current = false;
      }
    },
    [bridge, config?.disabled, refresh]
  );

  const activateAt = useCallback(
    async (index: number) => {
      const item = navItems[index];
      if (!item) return;
      if (item.kind === "plugin") {
        await togglePlugin(item.id, !item.on);
        return;
      }
      setOpen(false);
      try {
        await item.cmd.run();
      } catch (e) {
        console.error(e);
        alert(String(e));
      }
    },
    [navItems, setOpen, togglePlugin]
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((was) => !was);
        return;
      }
      if (open && e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, setOpen]);

  useEffect(() => {
    let cancelled = false;
    const unsubs: Array<() => void> = [];

    void listen("desk:open-cmdk", () => {
      if (!cancelled) setOpen(true);
    }).then((u) => unsubs.push(u));

    window.__deskOpenCmdk = () => setOpen(true);

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
      delete window.__deskOpenCmdk;
    };
  }, [setOpen]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const item = navItems[safeSelected];
      if (item?.kind === "plugin" && item.on) {
        void movePlugin(item.id, e.key === "ArrowUp" ? -1 : 1);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => clampSelected(s + 1, navItems.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => clampSelected(s - 1, navItems.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void activateAt(safeSelected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={shellRef} className="cmdk-root" data-testid="cmdk-root">
      <div className="cmdk-backdrop" onClick={() => setOpen(false)} />
      <div className="cmdk-panel" role="dialog" aria-label="命令面板">
        <div className="cmdk-head">
          <span className="cmdk-prompt">›</span>
          <input
            ref={inputRef}
            className="cmdk-input"
            type="text"
            placeholder="布局 / 插件 / 搜索更多…"
            autoComplete="off"
            spellCheck={false}
            value={filter}
            data-testid="cmdk-input"
            onChange={(e) => {
              setFilter(e.target.value);
              setSelected(0);
            }}
            onKeyDown={handleInputKeyDown}
          />
          <kbd>esc</kbd>
        </div>
        <SchemeComposer hidden={filter.trim().length > 0} />
        <CmdkList
          items={navItems}
          selected={safeSelected}
          onSelect={setSelected}
          onActivate={(idx) => void activateAt(idx)}
          onMovePlugin={(id, dir) => void movePlugin(id, dir)}
        />
      </div>
    </div>
  );
}

export default CmdkPanel;
