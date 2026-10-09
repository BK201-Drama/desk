import { useEffect, useRef, useState } from "react";
import type { PluginComponentProps } from "../../host/types";
import { showToast } from "../../host/toast";
import { isTextField } from "../../host/util";
import { useKeyboardInput } from "../../lib/useKeyboardInput";
import { useReminders } from "./useReminders";

export function RemindPanel({ ctx }: PluginComponentProps) {
  const setKeyboard = useKeyboardInput(ctx);
  const { items, refresh, applyList } = useReminders(ctx);
  const [popOpen, setPopOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [rule, setRule] = useState("once");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsubs = [
      ctx.registerCommand({
        id: "add",
        title: "添加待办",
        group: "待办",
        run: () => setPopOpen(true),
      }),
      ctx.registerCommand({
        id: "refresh",
        title: "刷新待办",
        group: "待办",
        run: () => void refresh(),
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [ctx, refresh]);

  useEffect(() => {
    if (!popOpen) return;
    const t = window.setTimeout(() => titleRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [popOpen]);

  useEffect(() => {
    if (!popOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPopOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popOpen]);

  const onFieldFocus = () => void setKeyboard(true);
  const onFieldBlur = () => {
    window.setTimeout(() => {
      if (!isTextField(document.activeElement)) void setKeyboard(false);
    }, 0);
  };

  const closePop = () => {
    setPopOpen(false);
    setTitle("");
    void setKeyboard(false);
  };

  const submitAdd = () => {
    const t = title.trim();
    if (!t) {
      showToast("先写标题");
      titleRef.current?.focus();
      return;
    }
    void ctx
      .invoke("remind_add", { title: t, rule })
      .then((raw) => {
        applyList(raw);
        closePop();
        ctx.emit("remind:add", { title: t, rule });
      })
      .catch((e) => showToast(String(e)));
  };

  return (
    <>
      <div className="remind" data-testid="remind-panel">
        <div className="remind-head">
          <span className="remind-label">待办</span>
          <button type="button" className="remind-add" onClick={() => setPopOpen(true)}>
            + 待办
          </button>
        </div>
        <div className="remind-items">
          {items.length === 0 ? (
            <button type="button" className="remind-row remind-empty" onClick={() => setPopOpen(true)}>
              <div className="body">
                <strong>暂无待办 · 点这里添加</strong>
              </div>
            </button>
          ) : (
            items.map((r) => (
              <div key={r.id} className={`remind-row${r.done ? " done" : ""}`}>
                <button
                  type="button"
                  className={`dot${r.done ? " checked" : ""}`}
                  aria-label="勾选"
                  onClick={() => {
                    void ctx
                      .invoke("remind_toggle", { id: r.id })
                      .then(applyList)
                      .catch((e) => showToast(String(e)));
                  }}
                />
                <div className="body">
                  <strong>{r.title}</strong>
                  <div className="sub">{r.rule_label}</div>
                </div>
                <button
                  type="button"
                  className="rm"
                  title="删除"
                  onClick={() => {
                    void ctx
                      .invoke("remind_remove", { id: r.id })
                      .then(applyList)
                      .catch((e) => showToast(String(e)));
                  }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      <div className={`todo-pop${popOpen ? " show" : ""}`}>
        <label>待办</label>
        <input
          ref={titleRef}
          type="text"
          placeholder="例如：买洗洁精"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={onFieldFocus}
          onBlur={onFieldBlur}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitAdd();
            }
          }}
        />
        <div className="row2">
          <div>
            <label>周期</label>
            <select
              value={rule}
              onChange={(e) => setRule(e.target.value)}
              onFocus={onFieldFocus}
              onBlur={onFieldBlur}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <option value="once">一次性</option>
              <option value="1m">每 1 月</option>
              <option value="1w">每 1 周</option>
              <option value="on15">每月 15 日</option>
            </select>
          </div>
          <div>
            <label>提示</label>
            <input type="text" readOnly value="到期 09:00 系统通知" />
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={closePop}>
            取消
          </button>
          <button type="button" className="primary" onClick={submitAdd}>
            添加
          </button>
        </div>
      </div>
    </>
  );
}

export default RemindPanel;
