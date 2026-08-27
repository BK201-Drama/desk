import { getCurrentWindow } from "@tauri-apps/api/window";
import type { HostContext, PluginModule } from "../../host/types";
import { escapeHtml, isTextField } from "../../host/util";

type ReminderDto = {
  id: string;
  title: string;
  rule: string;
  rule_label: string;
  done: boolean;
  created_at: number;
};

let rootEl: HTMLElement | null = null;
let ctxRef: HostContext | null = null;
let unsubEdit: (() => void) | null = null;

async function setTextInputActive(active: boolean) {
  if (!ctxRef) return;
  try {
    await ctxRef.invoke("set_keyboard_input", { active });
    if (active) await getCurrentWindow().setFocus();
  } catch (e) {
    console.warn("set_keyboard_input", e);
  }
}

function renderReminders(items: ReminderDto[]) {
  if (!rootEl || !ctxRef) return;
  const root = rootEl.querySelector("#remindItems");
  if (!root) return;
  if (!items.length) {
    root.innerHTML = `<div class="remind-row"><div class="body"><strong style="opacity:.5;font-weight:400">暂无待办</strong></div></div>`;
    return;
  }
  root.innerHTML = items
    .map(
      (r) => `
    <div class="remind-row${r.done ? " done" : ""}" data-id="${escapeHtml(r.id)}">
      <button type="button" class="dot${r.done ? " checked" : ""}" data-act="toggle" aria-label="勾选"></button>
      <div class="body">
        <strong>${escapeHtml(r.title)}</strong>
        <div class="sub">${escapeHtml(r.rule_label)}</div>
      </div>
      <button type="button" class="rm" data-act="remove" title="删除">×</button>
    </div>`
    )
    .join("");

  root.querySelectorAll<HTMLElement>(".remind-row").forEach((row) => {
    const id = row.dataset.id;
    if (!id || !ctxRef) return;
    row.querySelector('[data-act="toggle"]')?.addEventListener("click", () => {
      if (!ctxRef!.editing()) return;
      void ctxRef!
        .invoke<ReminderDto[]>("remind_toggle", { id })
        .then(renderReminders)
        .catch((e) => console.error(e));
    });
    row.querySelector('[data-act="remove"]')?.addEventListener("click", () => {
      if (!ctxRef!.editing()) return;
      void ctxRef!
        .invoke<ReminderDto[]>("remind_remove", { id })
        .then(renderReminders)
        .catch((e) => console.error(e));
    });
  });
}

async function loadReminders() {
  if (!ctxRef) return;
  try {
    const items = await ctxRef.invoke<ReminderDto[]>("remind_list");
    renderReminders(items);
  } catch (e) {
    console.error("remind_list", e);
  }
}

function wireTextFocus(el: HTMLElement) {
  const onFocus = () => void setTextInputActive(true);
  const onBlur = () => {
    window.setTimeout(() => {
      if (!isTextField(document.activeElement)) void setTextInputActive(false);
    }, 0);
  };
  for (const id of ["todoTitle", "todoRule"]) {
    const field = el.querySelector(`#${id}`);
    if (!field) continue;
    field.addEventListener("focus", onFocus);
    field.addEventListener("blur", onBlur);
    field.addEventListener("pointerdown", (e) => e.stopPropagation());
  }
}

const panel: PluginModule = {
  async mount(el, ctx) {
    rootEl = el;
    ctxRef = ctx;
    el.innerHTML = `
      <div class="remind">
        <div class="remind-head">
          <span class="remind-label">待办</span>
          <button type="button" class="remind-add" id="addTodo">+ 待办</button>
        </div>
        <div class="remind-items" id="remindItems"></div>
      </div>
      <div class="todo-pop" id="todoPop">
        <label>待办</label>
        <input id="todoTitle" type="text" placeholder="例如：买洗洁精" />
        <div class="row2">
          <div>
            <label>周期</label>
            <select id="todoRule">
              <option value="once">一次性</option>
              <option value="1m" selected>每 1 月</option>
              <option value="1w">每 1 周</option>
              <option value="on15">每月 15 日</option>
            </select>
          </div>
          <div>
            <label>提示</label>
            <input type="text" readonly value="可添加多条 · 持久化本机" />
          </div>
        </div>
        <div class="actions">
          <button type="button" id="todoCancel">取消</button>
          <button type="button" class="primary" id="todoSave">添加</button>
        </div>
      </div>`;

    const pop = el.querySelector("#todoPop");
    el.querySelector("#addTodo")?.addEventListener("click", () => {
      pop?.classList.add("show");
      (el.querySelector("#todoTitle") as HTMLInputElement | null)?.focus();
    });
    el.querySelector("#todoCancel")?.addEventListener("click", () => {
      pop?.classList.remove("show");
    });
    el.querySelector("#todoSave")?.addEventListener("click", () => {
      const input = el.querySelector("#todoTitle") as HTMLInputElement | null;
      const rule = el.querySelector("#todoRule") as HTMLSelectElement | null;
      const t = input?.value.trim() || "新待办";
      const r = rule?.value || "once";
      void ctx
        .invoke<ReminderDto[]>("remind_add", { title: t, rule: r })
        .then((items) => {
          renderReminders(items);
          pop?.classList.remove("show");
          if (input) input.value = "";
          ctx.emit("remind:add", { title: t, rule: r });
        })
        .catch((e) => alert(String(e)));
    });

    wireTextFocus(el);
    unsubEdit = ctx.onEditChange(() => {
      /* editing gates toggle/remove */
    });

    ctx.registerCommand({
      id: "add",
      title: "添加待办",
      group: "待办",
      run: () => {
        pop?.classList.add("show");
        (el.querySelector("#todoTitle") as HTMLInputElement | null)?.focus();
      },
    });
    ctx.registerCommand({
      id: "refresh",
      title: "刷新待办",
      group: "待办",
      run: () => loadReminders(),
    });

    void loadReminders();
  },
  unmount() {
    unsubEdit?.();
    unsubEdit = null;
    rootEl = null;
    ctxRef = null;
  },
};

export default panel;
