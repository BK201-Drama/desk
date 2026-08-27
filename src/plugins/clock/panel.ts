import type { PluginModule } from "../../host/types";
import { pad } from "../../host/util";
import "./panel.css";

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

let timer: number | null = null;
let root: HTMLElement | null = null;

function tick() {
  if (!root) return;
  const now = new Date();
  const timeEl = root.querySelector(".clock-time");
  const dateEl = root.querySelector(".clock-date");
  if (timeEl) {
    timeEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
  if (dateEl) {
    dateEl.textContent = `${DAYS[now.getDay()]} · ${MONTHS[now.getMonth()]} ${now.getDate()}`;
  }
}

const panel: PluginModule = {
  mount(el) {
    root = el;
    el.innerHTML = `
      <div class="desk-clock">
        <div class="clock-time">--:--</div>
        <div class="clock-date">---</div>
      </div>`;
    tick();
    timer = window.setInterval(tick, 1000);
  },
  unmount() {
    if (timer != null) window.clearInterval(timer);
    timer = null;
    root = null;
  },
};

export default panel;
