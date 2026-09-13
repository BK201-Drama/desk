/**
 * 看板自己的弹窗 —— 原生 `alert` / `confirm` / `prompt` 的替身。
 *
 * ── 为什么非要有这个文件 ──────────────────────────────────────────────────
 *
 * 原生对话框的样式**改不了**：`alert`/`confirm`/`prompt` 由 WebView2 自己画，
 * 不进页面渲染树，CSS 够不到。唯一的旋钮是 `AreDefaultScriptDialogsEnabled`
 * （只有开/关，没有化妆），而 wry 从头到尾没碰过它（子计划 §0 的 grep）。
 * 所以「弹窗样式」这件事**没有中间路线** —— 要么忍，要么自己画一个。
 * 2026-09-13 用户裁决：「优化一下弹窗的样式」→ 走后者。
 *
 * 换来的代价如实记：焦点、键盘、无障碍三件事从「系统负责」变成「自己负责」。
 * 这个文件管前两件；`role="dialog"` + `aria-modal` 是第三件的最小交代
 * （真要做全还得有 focus trap，今天只有 1~2 个可聚焦元素，Tab 一圈就回到开头）。
 *
 * ── 键盘租约：Task 15 那个真机 bug 的同一个坑 ─────────────────────────────
 *
 * desk 的窗口是 `WS_EX_NOACTIVATE`（`win_zorder.rs:16` 起整份文件在讲这件事），
 * 键盘本来就不进这个进程。原生 `prompt()` 因此在真机上「框画得出来、字打不进去」
 * （Task 15 申报的缺陷）。**自己画的输入框一样需要先借到键盘** —— 变的不是
 * 「要不要借」，是「借的时机」：
 *
 *   · 原生那条路（已删）：`withKeyboard` 在弹框**前** `await` 一次
 *   · 这里：**租约没到手就不渲染**（下面 `ready` 那一段）
 *
 * 第二种是**刻意**更严的。要躲的那个状态是「框在那儿、打字没反应」——
 * 一个看起来完全正常的界面配一个死的输入框，用户只能怀疑自己。把渲染排在借之后，
 * 这个状态就不存在：最坏也只是框晚几十毫秒出来，而那是看得见、能诊断的失败。
 * 反向代价只有一个：`set_keyboard_input` 永不返回时框永远不出来 —— 那是 IPC 层
 * 已经坏了，不是这条的锅。
 *
 * ── 为什么不用原生 `<dialog>` + `showModal()` ────────────────────────────
 *
 * `showModal()` 会把元素提进 **top layer**，样式由 `::backdrop` 管，看着更正统。
 * 但 top layer 的元素脱离 `.board` 的层叠上下文 —— 而 `.board`
 * （`styles.css` 的 `backdrop-filter`）是这份文档里唯一的那个包含块与层叠根。
 * 一提进 top layer，「对话框盖不盖得住 `.fence-menu`（z-index 40）」就不再由
 * z-index 决定，而由「谁在 top layer」决定 —— 两套规则并存，后来的人没法推理。
 * 保住「看板是个自洽的层叠世界」比重用一个标签值钱。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

/**
 * 能问的三件事。形状贴着被替掉的那三个原生函数 —— 调用点因此几乎是逐字搬迁，
 * 「换弹窗」和「改行为」不会混在同一个 diff 里。
 */
export type FenceDialogApi = {
  /** 用户输入的文字；取消返回 `null`。**两者不同**：空串是「他清了输入框」。 */
  prompt(o: { title: string; initial?: string; okLabel?: string }): Promise<string | null>;
  confirm(o: { title: string; detail?: string; okLabel?: string }): Promise<boolean>;
  /** 没有取消按钮，也没有「取消」这个答案 —— 它只报信。 */
  alert(o: { title: string; detail?: string; okLabel?: string }): Promise<void>;
};

type Kind = "prompt" | "confirm" | "alert";

type Request = {
  /** 自增序号，也当 React key：换一个请求 = 重挂载 = 重新借一次键盘。 */
  id: number;
  kind: Kind;
  title: string;
  detail?: string;
  initial: string;
  okLabel: string;
  cancelLabel: string;
  resolve: (v: unknown) => void;
};

/**
 * 弹窗的**命令通道**，与 `useMenuIo` 同一个套路：调用侧 `await` 一个答案，
 * 渲染侧由 `node` 挂到面板根里。
 *
 * ⚠️ `node` 必须渲染在 `.pane-fences` **里面**：它同时是样式审查的扫描根
 * （`e2e/style-audit.spec.ts`），挂在根外面那棵树就永远在护栏之外。
 */
export function useFenceDialogs(keyboard: (active: boolean) => Promise<void>): {
  dialog: FenceDialogApi;
  node: ReactNode;
} {
  const [req, setReq] = useState<Request | null>(null);
  const seq = useRef(0);

  const open = useCallback(
    (o: { kind: Kind; title: string; detail?: string; initial?: string; okLabel?: string }): Promise<unknown> =>
      new Promise((resolve) => {
        seq.current += 1;
        setReq({
          id: seq.current,
          initial: "",
          okLabel: "确定",
          cancelLabel: "取消",
          ...o,
          resolve,
        });
      }),
    []
  );

  const dialog = useMemo<FenceDialogApi>(
    () => ({
      prompt: (o) => open({ kind: "prompt", okLabel: "重命名", ...o }) as Promise<string | null>,
      confirm: (o) => open({ kind: "confirm", ...o }) as Promise<boolean>,
      // 「知道了」而不是「确定」：这一档没有问句，只有一句话要说。
      alert: (o) => open({ kind: "alert", okLabel: "知道了", ...o }) as Promise<void>,
    }),
    [open]
  );

  // 与 `FencePanel` 的 `menuOpenRef` 同一种写法：ref 在渲染期同步当前值。
  // 用它而不是在 setState 的更新函数里 `resolve` —— 更新函数必须是纯的
  // （StrictMode 下会被调两次，那样 promise 就被 resolve 两次）。
  const reqRef = useRef<Request | null>(null);
  reqRef.current = req;

  const onDone = useCallback((v: unknown) => {
    const cur = reqRef.current;
    reqRef.current = null;
    setReq(null);
    cur?.resolve(v);
  }, []);

  return {
    dialog,
    node: req ? (
      // key = 序号：连续两次弹窗是两个实例，租约的借/还各算各的，不互相吞。
      <FenceDialog key={req.id} req={req} keyboard={keyboard} onDone={onDone} />
    ) : null,
  };
}

function FenceDialog({
  req,
  keyboard,
  onDone,
}: {
  req: Request;
  keyboard: (active: boolean) => Promise<void>;
  onDone: (v: unknown) => void;
}) {
  /** 租约到手了吗。没到手**什么都不渲染** —— 见文件头。 */
  const [ready, setReady] = useState(false);
  /** 租约是不是还在我们手上。用来保证「借一次、还一次」，不重不漏。 */
  const leased = useRef(false);
  /** 这个请求答过没有。回车 / 点按钮 / 点外面可能挤在同一个 tick 里。 */
  const settled = useRef(false);
  const [value, setValue] = useState(req.initial);
  const inputRef = useRef<HTMLInputElement>(null);

  const release = useCallback(() => {
    if (!leased.current) return;
    leased.current = false;
    // ⚠️ 这里**不加** `isTextField(document.activeElement)` 那道守卫（别的还键盘处都有）：
    // 按下「确定」的这一刻，焦点还在**我们自己的输入框**上，守卫会把它当成
    // 「用户正在搜索框里打字，别动键盘」而拒绝归还 —— 租约就漏了。
    // 那道守卫护的是搜索框；对话框关掉之后没有任何文本框需要护。
    void keyboard(false);
  }, [keyboard]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await keyboard(true);
      // 借的路上组件就被卸载了（面板整个消失）→ 不能再 setState，租约也已经由
      // 下面的 cleanup 还掉。
      if (!alive) return;
      leased.current = true;
      setReady(true);
    })();
    return () => {
      alive = false;
      release(); // 兜底：正常路径上 `finish` 已经还过，这里是「面板没了」那条路
    };
  }, [keyboard, release]);

  const finish = useCallback(
    (v: unknown) => {
      if (settled.current) return;
      settled.current = true;
      // **先还，再交答案。** 顺序不是风格：调用侧 `await` 到答案之后马上就要发命令
      // （`fence_rename` 之类），而「还键盘」和那条命令是两次独立 IPC。
      // 在这里同步发出「还」，两条 IPC 的先后就定死在 `__MOCK_CALLS__` 那种有序日志里；
      // 要是留给卸载后的 effect cleanup 去还，就和调用侧的续体抢同一个微任务队列 ——
      // 时序变成不确定的，e2e 会随机红。
      release();
      onDone(v);
    },
    [onDone, release]
  );

  // 租约到手之后才聚焦：框还没出来就 `focus()`，聚焦的是一个不存在的世界。
  useEffect(() => {
    if (!ready) return;
    // 全选，和原生 `prompt` 一样 —— 想全换直接打字，想改一点就点进去。
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [ready]);

  const cancelValue = () => (req.kind === "prompt" ? null : req.kind === "confirm" ? false : undefined);
  const canSubmit = req.kind !== "prompt" || value.trim() !== "";

  const submit = () => {
    if (!canSubmit) return;
    finish(req.kind === "prompt" ? value : req.kind === "confirm" ? true : undefined);
  };

  /**
   * 键盘只处理两件事，**都在冒泡阶段 + `stopPropagation`**：
   * `FencePanel.tsx` 在 `document` 上还挂着一个 Escape（清空搜索）。不拦住的话
   * 一次 Esc 会同时关弹窗和清搜索 —— 「按一下少了两样东西」，和 `FenceContextMenu`
   * 里那条注释说的是同一个坑（那边用的是捕获，因为菜单要在别的消费者之前拿到它）。
   *
   * 回车一律走**主按钮**（不是「当前聚焦的那个按钮」）：原生消息框就是这个语义，
   * Tab 到「取消」再按回车仍然是确认。`preventDefault` 也是为这个 —— 不压掉的话
   * 焦点在主按钮上时浏览器还会再点它一次，等于提交两遍。
   */
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(cancelValue());
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  };

  const onOverlayDown = (e: ReactPointerEvent) => {
    if (e.target !== e.currentTarget) return; // 框里面的按下不算「点外面」
    finish(cancelValue());
  };

  if (!ready) return null;

  return (
    <div
      className="fence-dialog-overlay"
      data-testid="fence-dialog"
      onPointerDown={onOverlayDown}
      onKeyDown={onKeyDown}
    >
      <div className="fence-dialog" role="dialog" aria-modal="true" aria-label={req.title}>
        <div className="fence-dialog-title" data-testid="fence-dialog-title">
          {req.title}
        </div>
        {req.detail ? (
          <div className="fence-dialog-detail" data-testid="fence-dialog-detail">
            {req.detail}
          </div>
        ) : null}
        {req.kind === "prompt" ? (
          <input
            ref={inputRef}
            className="fence-dialog-input"
            data-testid="fence-dialog-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        ) : null}
        <div className="fence-dialog-actions">
          {req.kind !== "alert" ? (
            <button
              type="button"
              className="fence-dialog-btn"
              data-testid="fence-dialog-cancel"
              onClick={() => finish(cancelValue())}
            >
              {req.cancelLabel}
            </button>
          ) : null}
          <button
            type="button"
            className="fence-dialog-btn primary"
            data-testid="fence-dialog-ok"
            disabled={!canSubmit}
            onClick={submit}
          >
            {req.okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
