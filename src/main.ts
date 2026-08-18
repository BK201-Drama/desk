import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

type FenceItemDto = {
  id: string;
  label: string;
  path: string;
  icon: string | null;
};
type FenceDto = { name: string; items: FenceItemDto[] };

type GithubPinDto = {
  repo: string;
  desc: string;
  lang: string;
  lang_name: string;
  stars: string;
};
type GithubLangDto = { name: string; pct: number; color: string };
type GithubSnapshotDto = {
  login: string;
  name: string;
  bio: string;
  avatar_url: string;
  streak: number;
  year_total: number;
  weeks: number[][];
  pins: GithubPinDto[];
  langs: GithubLangDto[];
  cached: boolean;
  error: string | null;
};

type MulticaIssueDto = { st: string; title: string; who: string; id: string };
type MulticaSnapshotDto = {
  app_url: string;
  inbox: number;
  doing: number;
  review: number;
  issues: MulticaIssueDto[];
  runtime_online: boolean;
  cached: boolean;
  error: string | null;
};

type ReminderDto = {
  id: string;
  title: string;
  rule: string;
  rule_label: string;
  done: boolean;
  created_at: number;
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function tick() {
  const now = new Date();
  const t = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const timeEl = document.getElementById("time");
  const dateEl = document.getElementById("date");
  if (timeEl) timeEl.textContent = t;
  if (dateEl) {
    dateEl.textContent = `${DAYS[now.getDay()]} · ${MONTHS[now.getMonth()]} ${now.getDate()}`;
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderGithub(snap: GithubSnapshotDto) {
  const nameEl = document.getElementById("ghName");
  const handleEl = document.getElementById("ghHandle");
  const bioEl = document.getElementById("ghBio");
  const streakEl = document.getElementById("ghStreak");
  const avatar = document.getElementById("ghAvatar");
  if (nameEl) nameEl.textContent = snap.name || snap.login;
  if (handleEl) handleEl.textContent = `@${snap.login}`;
  if (bioEl) {
    bioEl.textContent = snap.bio || "—";
    if (snap.cached && snap.error) {
      bioEl.title = `缓存数据：${snap.error}`;
    }
  }
  if (streakEl) streakEl.textContent = String(snap.streak);
  if (avatar) {
    if (snap.avatar_url) {
      avatar.textContent = "";
      avatar.style.backgroundImage = `url('${snap.avatar_url}')`;
      avatar.classList.add("has-img");
    } else {
      avatar.textContent = (snap.name || snap.login || "?").slice(0, 1).toUpperCase();
      avatar.style.backgroundImage = "";
      avatar.classList.remove("has-img");
    }
  }

  const grid = document.getElementById("grid");
  if (grid) {
    grid.innerHTML = "";
    for (const week of snap.weeks) {
      for (let d = 0; d < 7; d++) {
        const lv = week[d] ?? 0;
        const cell = document.createElement("div");
        cell.className = `cell l${lv}`;
        grid.appendChild(cell);
      }
    }
  }
  const yc = document.getElementById("yearCount");
  if (yc) yc.textContent = String(snap.year_total);

  const pinsEl = document.getElementById("pins");
  if (pinsEl) {
    pinsEl.innerHTML = snap.pins
      .map(
        (p) => `
    <div class="pin">
      <div class="repo">${escapeHtml(p.repo)}</div>
      <div class="desc">${escapeHtml(p.desc || "—")}</div>
      <div class="meta">
        <span><i class="lang-dot" style="background:${escapeHtml(p.lang)}"></i>${escapeHtml(p.lang_name)}</span>
        <span>★ ${escapeHtml(p.stars)}</span>
      </div>
    </div>`
      )
      .join("");
  }

  const bar = document.getElementById("langBar");
  const legend = document.getElementById("langLegend");
  if (bar && legend) {
    bar.innerHTML = snap.langs
      .map((l) => `<i style="width:${l.pct}%;background:${escapeHtml(l.color)}"></i>`)
      .join("");
    legend.innerHTML = snap.langs
      .map(
        (l) =>
          `<span style="--c:${escapeHtml(l.color)}">${escapeHtml(l.name)} ${l.pct}%</span>`
      )
      .join("");
  }
}

async function loadGithub() {
  try {
    const snap = await invoke<GithubSnapshotDto>("github_snapshot");
    renderGithub(snap);
  } catch (e) {
    console.error("github_snapshot", e);
    const bioEl = document.getElementById("ghBio");
    if (bioEl) bioEl.textContent = `GitHub 未接通：${String(e)}`;
  }
}

function renderMc(snap: MulticaSnapshotDto) {
  const set = (id: string, n: number) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(n);
  };
  set("mcInbox", snap.inbox);
  set("mcDoing", snap.doing);
  set("mcReview", snap.review);

  const list = document.getElementById("mcList");
  if (list) {
    if (!snap.issues.length) {
      list.innerHTML = `<div class="mc-row"><span class="title" style="opacity:.55">暂无进行中的 issue</span></div>`;
    } else {
      list.innerHTML = snap.issues
        .map(
          (i) => `
    <div class="mc-row">
      <span class="st ${escapeHtml(i.st)}">${escapeHtml(i.st)}</span>
      <span class="title">${escapeHtml(i.title)}</span>
      <span class="who">${escapeHtml(i.who)}</span>
    </div>`
        )
        .join("");
    }
  }

  const live = document.getElementById("mcLive");
  if (live) {
    live.textContent = snap.runtime_online ? "runtime online" : "runtime offline";
    live.classList.toggle("off", !snap.runtime_online);
  }
  const hint = document.getElementById("mcFootHint");
  if (hint) {
    hint.textContent = snap.cached
      ? snap.error
        ? "缓存 · 拉取失败"
        : "缓存"
      : "本地实例";
    if (snap.error) hint.title = snap.error;
  }
}

async function loadMultica() {
  try {
    const snap = await invoke<MulticaSnapshotDto>("multica_snapshot");
    renderMc(snap);
  } catch (e) {
    console.error("multica_snapshot", e);
    const list = document.getElementById("mcList");
    if (list) {
      list.innerHTML = `<div class="mc-row"><span class="title">Multica 未接通：${escapeHtml(String(e))}</span></div>`;
    }
  }
}

function renderReminders(items: ReminderDto[]) {
  const root = document.getElementById("remindItems");
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
    if (!id) return;
    row.querySelector('[data-act="toggle"]')?.addEventListener("click", () => {
      if (!editing) return;
      void invoke<ReminderDto[]>("remind_toggle", { id })
        .then(renderReminders)
        .catch((e) => console.error(e));
    });
    row.querySelector('[data-act="remove"]')?.addEventListener("click", () => {
      if (!editing) return;
      void invoke<ReminderDto[]>("remind_remove", { id })
        .then(renderReminders)
        .catch((e) => console.error(e));
    });
  });
}

async function loadReminders() {
  try {
    const items = await invoke<ReminderDto[]>("remind_list");
    renderReminders(items);
  } catch (e) {
    console.error("remind_list", e);
  }
}

function iconUrl(icon: string | null, label: string): string {
  if (icon) {
    try {
      return `background-image:url('${convertFileSrc(icon)}')`;
    } catch {
      return `background-image:url('${icon}')`;
    }
  }
  if (label === "回收站") return "background:linear-gradient(145deg,#94a3b8,#475569)";
  if (label === "此电脑") return "background:linear-gradient(145deg,#93c5fd,#2563eb)";
  return "background:linear-gradient(145deg,#c4b5fd,#7c3aed)";
}

type FenceLayout = { name: string; ids: string[] };

const DRAG_THRESHOLD_PX = 6;

let fencePointer: {
  id: number;
  el: HTMLElement;
  startX: number;
  startY: number;
  active: boolean;
} | null = null;
let fenceSuppressClick = false;

function collectFenceLayout(): FenceLayout[] {
  const root = document.getElementById("fences");
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(".fence")]
    .map((fence) => {
      const name = fence.dataset.name ?? "";
      const ids = [...fence.querySelectorAll<HTMLElement>(".fence-app")]
        .map((el) => el.dataset.id ?? "")
        .filter((id) => id && !id.startsWith("sys-"));
      return { name, ids };
    })
    .filter((f) => f.name && f.name !== "系统");
}

function persistFenceOrder() {
  const layout = collectFenceLayout();
  void invoke<FenceDto[]>("fence_save_order", { layout })
    .then((fences) => renderFences(fences))
    .catch((e) => console.error("fence_save_order", e));
}

function refreshFenceCounts() {
  const root = document.getElementById("fences");
  if (!root) return;
  let total = 0;
  root.querySelectorAll<HTMLElement>(".fence").forEach((fence) => {
    const n = fence.querySelectorAll(".fence-app").length;
    total += n;
    const em = fence.querySelector(".fence-title em");
    if (em) em.textContent = String(n);
  });
  const countEl = document.getElementById("fenceCount");
  if (countEl) countEl.textContent = `· ${total}`;
}

/** Nearest icon to insert before, or null to append. */
function dragInsertTarget(
  grid: HTMLElement,
  x: number,
  y: number,
  dragging: HTMLElement
): HTMLElement | null {
  const apps = [...grid.querySelectorAll<HTMLElement>(".fence-app")].filter(
    (el) => el !== dragging
  );
  for (const app of apps) {
    const r = app.getBoundingClientRect();
    const before =
      y < r.top + r.height / 2 || (y <= r.bottom && x < r.left + r.width / 2);
    if (before) return app;
  }
  return null;
}

function placeDraggingAtPoint(dragging: HTMLElement, x: number, y: number) {
  dragging.style.pointerEvents = "none";
  const under = document.elementFromPoint(x, y);
  dragging.style.pointerEvents = "";
  const grid = under?.closest<HTMLElement>(".fence-grid");
  if (!grid) return;
  const fence = grid.closest<HTMLElement>(".fence");
  if (!fence || fence.dataset.name === "系统") return;

  document
    .querySelectorAll(".fence-grid.drag-over")
    .forEach((el) => el.classList.remove("drag-over"));
  grid.classList.add("drag-over");

  const after = dragInsertTarget(grid, x, y, dragging);
  if (after == null) {
    if (dragging.parentElement !== grid || grid.lastElementChild !== dragging) {
      grid.appendChild(dragging);
    }
  } else if (after !== dragging.nextElementSibling) {
    grid.insertBefore(dragging, after);
  }
}

function endFencePointer(persist: boolean) {
  if (!fencePointer) return;
  const { el, active, id } = fencePointer;
  el.classList.remove("dragging");
  try {
    el.releasePointerCapture(id);
  } catch {
    /* ignore */
  }
  window.removeEventListener("pointermove", onFenceWindowMove);
  window.removeEventListener("pointerup", onFenceWindowUp);
  window.removeEventListener("pointercancel", onFenceWindowCancel);
  document
    .querySelectorAll(".fence-grid.drag-over")
    .forEach((node) => node.classList.remove("drag-over"));
  fencePointer = null;
  if (active) {
    fenceSuppressClick = true;
    refreshFenceCounts();
    if (persist) persistFenceOrder();
  }
}

function onFenceWindowMove(e: PointerEvent) {
  if (!fencePointer || e.pointerId !== fencePointer.id) return;
  const dx = e.clientX - fencePointer.startX;
  const dy = e.clientY - fencePointer.startY;
  if (!fencePointer.active) {
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    fencePointer.active = true;
    fencePointer.el.classList.add("dragging");
  }
  e.preventDefault();
  placeDraggingAtPoint(fencePointer.el, e.clientX, e.clientY);
}

function onFenceWindowUp(e: PointerEvent) {
  if (!fencePointer || e.pointerId !== fencePointer.id) return;
  endFencePointer(true);
}

function onFenceWindowCancel(e: PointerEvent) {
  if (!fencePointer || e.pointerId !== fencePointer.id) return;
  endFencePointer(false);
}

function wireFenceDnD(root: HTMLElement) {
  root.onpointerdown = (e) => {
    if (!editing || e.button !== 0) return;
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>(".fence-app");
    if (!btn || !root.contains(btn)) return;
    if ((btn.dataset.id ?? "").startsWith("sys-")) return;
    if (btn.closest<HTMLElement>(".fence")?.dataset.name === "系统") return;

    fencePointer = {
      id: e.pointerId,
      el: btn,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
    window.addEventListener("pointermove", onFenceWindowMove);
    window.addEventListener("pointerup", onFenceWindowUp);
    window.addEventListener("pointercancel", onFenceWindowCancel);
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  root.onpointermove = (e) => {
    const over = (e.target as HTMLElement | null)?.closest<HTMLElement>(".fence-app");
    const next = over
      ? editing
        ? fencePointer?.active
          ? "grabbing"
          : "grab"
        : "pointer"
      : "default";
    void invoke("set_cursor", { icon: next }).catch(() => {});
  };
  root.onpointerleave = () => {
    void invoke("set_cursor", { icon: "default" }).catch(() => {});
  };

  root.querySelectorAll<HTMLButtonElement>(".fence-app").forEach((btn) => {
    btn.onclick = (e) => {
      // 单击不启动；留给拖拽排序。拖拽后吞掉残余 click。
      if (fenceSuppressClick) {
        fenceSuppressClick = false;
        e.preventDefault();
      }
    };
    btn.ondblclick = (e) => {
      e.preventDefault();
      if (fenceSuppressClick) {
        fenceSuppressClick = false;
        return;
      }
      const path = btn.dataset.path;
      if (!path) return;
      void invoke("fence_launch", { path }).catch((err) => console.error(err));
    };
  });
}

function renderFences(fences: FenceDto[]) {
  const root = document.getElementById("fences");
  if (!root) return;
  let total = 0;
  root.innerHTML = fences
    .map((f) => {
      total += f.items.length;
      const apps = f.items
        .map((item) => {
          const bg = iconUrl(item.icon, item.label);
          const pathAttr = item.path.replace(/"/g, "&quot;");
          const idAttr = item.id.replace(/"/g, "&quot;");
          return `<button type="button" class="fence-app" data-id="${idAttr}" data-path="${pathAttr}" title="${item.label}">
          <div class="face" style="${bg}"></div>
          <span class="label">${item.label}</span>
        </button>`;
        })
        .join("");
      return `<div class="fence" data-name="${f.name}">
      <div class="fence-title">${f.name} <em>${f.items.length}</em></div>
      <div class="fence-grid">${apps}</div>
    </div>`;
    })
    .join("");

  const countEl = document.getElementById("fenceCount");
  if (countEl) countEl.textContent = `· ${total}`;

  wireFenceDnD(root);
}

async function loadFences() {
  try {
    const fences = await invoke<FenceDto[]>("fence_takeover");
    renderFences(fences);
  } catch (e) {
    console.warn("fence_takeover failed, try list", e);
    try {
      const fences = await invoke<FenceDto[]>("fence_list");
      renderFences(fences);
    } catch (e2) {
      console.error(e2);
      const root = document.getElementById("fences");
      if (root) {
        root.innerHTML = `<div class="fence"><div class="fence-title">围栏</div><p style="font-size:11px;color:#6b7a8c;padding:4px">无法接管桌面：${String(e)}</p></div>`;
      }
    }
  }
}

let editing = false;

async function setEditing(on: boolean) {
  editing = on;
  const board = document.getElementById("board");
  const btn = document.getElementById("editToggle");
  board?.classList.toggle("editing", on);
  if (btn) btn.title = on ? "完成" : "编辑";
  if (btn) btn.setAttribute("aria-label", on ? "完成" : "编辑");
}

function wireUi() {
  document.getElementById("editToggle")?.addEventListener("click", () => {
    void setEditing(!editing);
  });

  const autoBtn = document.getElementById("autostartToggle");
  const syncAutostartBtn = async () => {
    if (!autoBtn) return;
    try {
      const on = await invoke<boolean>("autostart_get");
      autoBtn.title = on ? "开机自启：开（点击关闭）" : "开机自启：关（点击开启）";
      autoBtn.setAttribute("aria-label", autoBtn.title);
      autoBtn.classList.toggle("on", on);
    } catch (e) {
      autoBtn.title = String(e);
      autoBtn.classList.remove("on");
    }
  };
  void syncAutostartBtn();
  autoBtn?.addEventListener("click", () => {
    void (async () => {
      try {
        const cur = await invoke<boolean>("autostart_get");
        await invoke<boolean>("autostart_set", { enabled: !cur });
        await syncAutostartBtn();
      } catch (e) {
        alert(String(e));
      }
    })();
  });

  document.getElementById("fenceRestore")?.addEventListener("click", () => {
    if (!confirm("把图标还原回系统桌面？")) return;
    void invoke("fence_restore")
      .then(() => loadFences())
      .catch((e) => alert(String(e)));
  });

  const pop = document.getElementById("todoPop");
  document.getElementById("addTodo")?.addEventListener("click", () => {
    pop?.classList.add("show");
    document.getElementById("todoTitle")?.focus();
  });
  document.getElementById("todoCancel")?.addEventListener("click", () => {
    pop?.classList.remove("show");
  });
  document.getElementById("todoSave")?.addEventListener("click", () => {
    const input = document.getElementById("todoTitle") as HTMLInputElement | null;
    const rule = document.getElementById("todoRule") as HTMLSelectElement | null;
    const t = input?.value.trim() || "新待办";
    const r = rule?.value || "once";
    void invoke<ReminderDto[]>("remind_add", { title: t, rule: r })
      .then((items) => {
        renderReminders(items);
        pop?.classList.remove("show");
        if (input) input.value = "";
      })
      .catch((e) => alert(String(e)));
  });

  document.getElementById("mcOpen")?.addEventListener("click", () => {
    void (async () => {
      try {
        const url = await invoke<string>("multica_app_url");
        await openUrl(url);
      } catch (e) {
        console.warn("multica_app_url failed, fallback localhost", e);
        const fallback = "http://localhost:18473";
        try {
          await openUrl(fallback);
        } catch {
          window.open(fallback, "_blank");
        }
      }
    })();
  });
}

window.addEventListener("DOMContentLoaded", () => {
  tick();
  setInterval(tick, 1000);
  wireUi();
  // Critical path first; network panels deferred to cut peak startup memory.
  void loadReminders();
  void loadFences();
  void setEditing(false);
  window.setTimeout(() => {
    void loadGithub();
    void loadMultica();
  }, 800);
});
