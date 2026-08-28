let timer: number | null = null;

export function showToast(message: string, ms = 2200): void {
  let el = document.getElementById("deskToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "deskToast";
    el.className = "desk-toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  if (timer != null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    el?.classList.remove("show");
    timer = null;
  }, ms);
}
