import type { PluginModule } from "../../host/types";

const panel: PluginModule = {
  mount(el, ctx) {
    el.innerHTML = `<div class="hello-plugin" style="font-size:11px;opacity:.7;padding:6px 0;border-top:1px dashed rgba(26,35,50,.15);margin-top:6px;font-family:Cascadia Code,Consolas,monospace">
      <span style="color:#2d6a4f">▸</span> bundled plugin <b>hello</b> online
    </div>`;
    ctx.emit("hello:ping", { source: "bundled" });
  },
};

export default panel;
