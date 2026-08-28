import { useEffect, useState } from "react";
import type { PluginComponentProps } from "../../host/types";
import { isTextField } from "../../host/util";
import { useKeyboardInput } from "../../application/host/useKeyboardInput";
import { useReminders } from "../../application/remind/useReminders";

export function RemindPanel({ ctx }: PluginComponentProps) {
  const setKeyboard = useKeyboardInput(ctx);
  const { items, refresh, applyList } = useReminders(ctx);
  const [popOpen, setPopOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [rule, setRule] = useState("1m");

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

  const onFieldFocus = () => void setKeyboard(true);
  const onFieldBlur = () => {
    window.setTimeout(() => {
      if (!isTextField(document.activeElement)) void setKeyboard(false);
    }, 0);
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
            <div className="remind-row">
              <div className="body">
                <strong style={{ opacity: 0.5, fontWeight: 400 }}>暂无待办</strong>
              </div>
            </div>
          ) : (
            items.map((r) => (
              <div key={r.id} className={`remind-row${r.done ? " done" : ""}`}>
                <button
                  type="button"
                  className={`dot${r.done ? " checked" : ""}`}
                  aria-label="勾选"
                  onClick={() => {
                    if (!ctx.editing()) return;
                    void ctx
                      .invoke("remind_toggle", { id: r.id })
                      .then(applyList)
                      .catch((e) => console.error(e));
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
                    if (!ctx.editing()) return;
                    void ctx
                      .invoke("remind_remove", { id: r.id })
                      .then(applyList)
                      .catch((e) => console.error(e));
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
          type="text"
          placeholder="例如：买洗洁精"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={onFieldFocus}
          onBlur={onFieldBlur}
          onPointerDown={(e) => e.stopPropagation()}
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
            <input type="text" readOnly value="可添加多条 · 持久化本机" />
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={() => setPopOpen(false)}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              const t = title.trim() || "新待办";
              void ctx
                .invoke("remind_add", { title: t, rule })
                .then((raw) => {
                  applyList(raw);
                  setPopOpen(false);
                  setTitle("");
                  ctx.emit("remind:add", { title: t, rule });
                })
                .catch((e) => alert(String(e)));
            }}
          >
            添加
          </button>
        </div>
      </div>
    </>
  );
}

export default RemindPanel;
