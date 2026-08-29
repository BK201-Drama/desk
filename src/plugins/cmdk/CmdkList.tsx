import { useEffect, useRef } from "react";
import type { NavItem } from "./navLogic";
import { buildRows } from "./navLogic";

function Switch({ on }: { on: boolean }) {
  return (
    <span className={`cmdk-switch${on ? " is-on" : ""}`} aria-hidden="true">
      <span className="cmdk-switch-knob" />
    </span>
  );
}

function OrderControls({
  id,
  on,
  onMove,
}: {
  id: string;
  on: boolean;
  onMove: (dir: -1 | 1) => void;
}) {
  if (!on || id === "cmdk") return null;
  return (
    <span className="cmdk-order" data-plugin-order={id}>
      <button
        type="button"
        className="cmdk-order-btn"
        title="上移 (Alt+↑)"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMove(-1);
        }}
      >
        ↑
      </button>
      <button
        type="button"
        className="cmdk-order-btn"
        title="下移 (Alt+↓)"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMove(1);
        }}
      >
        ↓
      </button>
    </span>
  );
}

type Props = {
  items: NavItem[];
  selected: number;
  onSelect: (index: number) => void;
  onActivate: (index: number) => void;
  onMovePlugin: (id: string, dir: -1 | 1) => void;
};

export function CmdkList({ items, selected, onSelect, onActivate, onMovePlugin }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector(".cmdk-item.is-selected");
    el?.scrollIntoView({ block: "nearest" });
  }, [selected, items]);

  if (!items.length) {
    return (
      <div className="cmdk-list" data-testid="cmdk-list">
        <div className="cmdk-empty">无匹配</div>
      </div>
    );
  }

  const rows = buildRows(items);

  return (
    <div className="cmdk-list" ref={listRef} data-testid="cmdk-list">
      {rows.map((row, i) => {
        if (row.kind === "head") {
          return (
            <div key={`h-${row.label}-${i}`} className="cmdk-section">
              {row.label}
            </div>
          );
        }
        const sel = row.index === selected ? " is-selected" : "";
        const item = row.item;
        if (item.kind === "plugin") {
          return (
            <button
              key={`p-${item.id}`}
              type="button"
              className={`cmdk-item cmdk-item-row${sel}`}
              data-idx={row.index}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest(".cmdk-order-btn")) return;
                onActivate(row.index);
              }}
            >
              <span className="cmdk-title">{item.title}</span>
              <OrderControls
                id={item.id}
                on={item.on}
                onMove={(dir) => onMovePlugin(item.id, dir)}
              />
              <Switch on={item.on} />
            </button>
          );
        }
        return (
          <button
            key={`c-${item.cmd.id}`}
            type="button"
            className={`cmdk-item${sel}`}
            data-idx={row.index}
            onMouseEnter={() => onSelect(row.index)}
            onClick={() => onActivate(row.index)}
          >
            <span className="cmdk-title">{item.cmd.title}</span>
            {item.cmd.hint ? <span className="cmdk-meta">{item.cmd.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
