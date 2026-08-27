import type { HostContext, PluginModule } from "../../host/types";
import { listMounted } from "../../host/registry";
import "./panel.css";

type HudState = {
  editing: boolean;
  pluginCount: number;
  lastOk: boolean | null;
  ghAge: string;
  mcAge: string;
};

let root: HTMLElement | null = null;
let ctxRef: HostContext | null = null;
let unsubs: Array<() => void> = [];
let timer: number | null = null;
let state: HudState = {
  editing: false,
  pluginCount: 0,
  lastOk: null,
  ghAge: "—",
  mcAge: "—",
};
const syncMarks: Record<string, number> = {};

function ageLabel(at: number | undefined): string {
  if (!at) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

function render() {
  if (!root) return;
  const rpc =
    state.lastOk == null ? "·" : state.lastOk ? "ok" : "err";
  root.innerHTML = `
    <div class="ops-hud" title="Ops · Ctrl+K 可关闭">
      <span class="seg ${state.editing ? "on" : ""}">${state.editing ? "EDIT" : "live"}</span>
      <span class="seg">${state.pluginCount}p</span>
      <span class="seg">gh ${state.ghAge}</span>
      <span class="seg">mc ${state.mcAge}</span>
      <span class="seg rpc">${rpc}</span>
    </div>`;
}

function refreshMeta() {
  state.pluginCount = listMounted().length;
  state.editing = ctxRef?.editing() ?? false;
  state.ghAge = ageLabel(syncMarks["github"]);
  state.mcAge = ageLabel(syncMarks["multica"]);
  render();
}

const panel: PluginModule = {
  async mount(el, ctx) {
    root = el;
    ctxRef = ctx;
    el.classList.add("ops-hud-host");
    unsubs.push(
      ctx.on("*", (ev) => {
        if (ev.type === "invoke:ok" || ev.type === "invoke:err") {
          const cmd = (ev.detail as { cmd?: string } | null)?.cmd;
          if (cmd === "set_cursor" || cmd === "set_keyboard_input") return;
          state.lastOk = ev.type === "invoke:ok";
        }
        if (ev.type === "github:sync") syncMarks["github"] = ev.at;
        if (ev.type === "multica:sync") syncMarks["multica"] = ev.at;
        if (
          ev.type === "plugin:ready" ||
          ev.type === "plugin:mounted" ||
          ev.type === "plugin:unmounted"
        ) {
          state.pluginCount = listMounted().length;
        }
      })
    );
    unsubs.push(ctx.onEditChange(() => refreshMeta()));
    timer = window.setInterval(refreshMeta, 2000);
    refreshMeta();
  },
  unmount() {
    for (const u of unsubs) u();
    unsubs = [];
    if (timer != null) window.clearInterval(timer);
    timer = null;
    root = null;
    ctxRef = null;
  },
};

export default panel;
