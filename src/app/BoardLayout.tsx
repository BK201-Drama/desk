import { useEffect, useRef } from "react";
import type { MountEntry } from "../host/mount-store";
import { useEditing } from "./useEditing";
import { useMountEntries } from "../host/mount-store";

function PluginSurface({ entry }: { entry: MountEntry }) {
  const { manifest, mod, ctx, order, error } = entry;
  const editing = useEditing();
  const hostRef = useRef<HTMLDivElement>(null);
  const Component = mod.Component;

  useEffect(() => {
    if (Component || error) return;
    const el = hostRef.current;
    if (!el || !mod.mount) return;
    let cancelled = false;
    void (async () => {
      try {
        await mod.mount?.(el, ctx);
      } catch (e) {
        if (!cancelled) console.error(`plugin mount failed: ${manifest.id}`, e);
      }
    })();
    return () => {
      cancelled = true;
      void mod.unmount?.();
    };
  }, [Component, ctx, error, manifest.id, mod]);

  const reorderable = editing && manifest.slot === "left";

  return (
    <div
      ref={hostRef}
      data-plugin={manifest.id}
      className={[
        "plugin-root",
        `plugin-${manifest.id}`,
        manifest.slot === "overlay" ? "plugin-overlay-root" : "",
        reorderable ? "plugin-reorderable" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ order }}
      draggable={reorderable}
    >
      {error ? (
        <div className="plugin-error" title={error}>
          插件 {manifest.id} 加载失败
        </div>
      ) : Component ? (
        <Component ctx={ctx} />
      ) : null}
    </div>
  );
}

function Slot({
  id,
  testId,
  className,
  slot,
  as: Tag = "section",
}: {
  id: string;
  testId: string;
  className: string;
  slot: "left" | "right" | "overlay";
  as?: "section" | "div";
}) {
  const entries = useMountEntries()
    .filter((e) => e.manifest.slot === slot)
    .slice()
    .sort(
      (a, b) => a.order - b.order || a.manifest.id.localeCompare(b.manifest.id)
    );

  return (
    <Tag className={className} id={id} data-testid={testId}>
      {entries.map((e) => (
        <PluginSurface key={e.manifest.id} entry={e} />
      ))}
    </Tag>
  );
}

/** 看板：唯一 React 树内按槽位渲染已挂载插件 */
export function BoardLayout() {
  return (
    <div className="board" id="board" data-testid="desk-board">
      <Slot id="slot-left" testId="slot-left" className="pane-info" slot="left" />
      <Slot
        id="slot-right"
        testId="slot-right"
        className="pane-fences-host"
        slot="right"
      />
      <Slot
        id="slot-overlay"
        testId="slot-overlay"
        className="slot-overlay"
        slot="overlay"
        as="div"
      />
    </div>
  );
}
