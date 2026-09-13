/**
 * 右键菜单的**纯逻辑**：出哪些项、每项调到哪个命令、菜单位置怎么夹进视口。
 *
 * 为什么单独一个文件、为什么 `contextMenuModel` 要收一个 `io` 端口：
 * 菜单的行为合同几乎全在「点这项会调到哪个命令、参数是什么」上，而那句断言
 * 只有把命令通道做成一个可替换的参数才写得出来。与 `model.ts` + `model.test.ts`
 * 同形：纯逻辑一个文件，测试一个文件，React 那一侧只管画。
 *
 * 计划里的签名是 `contextMenuModel(target)`（单参）。加第二参数是**故意**的偏离，
 * 理由就是上面那条 —— 见子计划 §1.1。
 */
import { ROWS_MAX, SYS_ID_PREFIX, type FenceItem } from "./model";

export type MenuTarget =
  | { kind: "blank" }
  | { kind: "item"; item: FenceItem; isDir: boolean }
  | { kind: "sys"; item: FenceItem }
  /** 围栏标题（2026-09-13）。**只给真分类**：`最近` 那一栏没有 `data-name`，
      `FencePanel` 的解析器走不到这里 —— 它不是分类，不能收起、没有高度可调。 */
  | { kind: "fence"; name: string; collapsed: boolean; rows: number };

export type MenuItem = {
  id: string;
  label: string;
  enabled: boolean;
  submenu?: MenuItem[];
  run: () => void;
};

/**
 * 菜单的**对外动作**。一个端口对象，而不是把 `ctx` 直接塞进来 ——
 * 于是这个模块一行 `react` / `tauri` 都不 import，单测里传 spy 就能跑。
 *
 * 注意这里**没有**「刷新看板」这一项：spec §4.2 的数据流图规定
 * 「用户操作只写桌面，前端等 watcher 推」（单一更新路径）。菜单跑完就关，
 * `useFences` 已有的 `ctx.on("fence:changed")` 会自己换掉那一帧。
 */
export type MenuIo = {
  /**
   * 打开。**带 id**，虽然命令本身只需要 path。
   *
   * 面板启动东西的唯一入口是 `FencePanel` 的 `doLaunch(path, id)`，
   * 它顺手把 id 记进「最近」—— 不传 id 的话，从右键菜单打开的东西**不进最近**。
   * 那是「只在某一条路径上复现」的怪 bug，靠读代码看不出来，所以从端口签名上堵死。
   */
  open: (path: string, id: string) => void;
  openWith: (path: string) => void;
  reveal: (path: string) => void;
  /** 空白处的新建。只给 folder / txt —— `lnk` 需要一个目标，而空白处没有（见 `blankMenu`）。 */
  newItem: (kind: "folder" | "txt") => void;
  clipboard: (path: string, cut: boolean) => void;
  paste: () => void;
  rename: (path: string) => void;
  remove: (path: string) => void;
  sendTo: (path: string) => void;
  compress: (path: string) => void;
  properties: (path: string) => void;
  /**
   * 收起 / 展开某一栏（2026-09-13）。写 `fence.json` 的 `ui.collapsed`。
   * 点标题整行也是它 —— 菜单只是第二条路（可发现性）。
   */
  setCollapsed: (name: string, collapsed: boolean) => void;
  /** 自定义高度（2026-09-13）。`1..ROWS_MAX` 行；**`0` = 自动**。写 `ui.rows`。 */
  setRows: (name: string, rows: number) => void;
};

/** 分隔线的 id。渲染层见到它就画一条 `<hr>` 而不是一个按钮。 */
export const SEP_ID = "__sep__";

/**
 * 分组线本身也是一个 `MenuItem` —— 这样 `contextMenuModel` 的返回值仍然是计划里
 * 那个平坦的 `MenuItem[]`，而「哪几项归一组」这个信息只有模型知道（渲染层不该再判一次）。
 */
export const SEP: MenuItem = { id: SEP_ID, label: "", enabled: false, run: () => {} };

export const isSeparator = (i: MenuItem): boolean => i.id === SEP_ID;

/** 一个条目该用哪一类目标。判据只有 id 前缀一个（`sys-`），与 `model.ts` 同源。 */
export function targetFor(item: FenceItem): MenuTarget {
  if (item.id.startsWith(SYS_ID_PREFIX)) return { kind: "sys", item };
  return { kind: "item", item, isDir: item.isDir };
}

/**
 * 可用性一律用**「不出现在菜单里」**表达，不用灰掉 —— 桌面右键的资源管理器也是隐藏。
 * 于是 `enabled` 今天恒为 `true`；它留着是因为计划把它定成了接口的一部分，
 * 而它是未来「只读项」这类局部禁用的唯一落点（单测里有一条钉住这个不变量）。
 *
 * 三个隐藏规则的**理由**（不是随手一刀）：
 *   - 目录不给「打开方式」：文件夹没有「打开方式」，资源管理器也不给。
 *   - 空白处才给「新建 ▸ / 粘贴」：`fence_create` 写的是用户桌面、`fence_paste` 粘的是桌面，
 *     两个命令都**没有**「落到某个文件夹」的参数（`ops::fence_delete` / `ops::fence_compress`）——
 *     挂在目录项上就是在骗用户：点了不会进那个目录。
 *   - sys 只留「打开」（spec §7.4）：`shell:` 伪路径既不能改名也不能删。
 */
export function contextMenuModel(target: MenuTarget, io: MenuIo): MenuItem[] {
  if (target.kind === "blank") return blankMenu(io);
  if (target.kind === "fence") return fenceMenu(target, io);
  if (target.kind === "sys") {
    const { path: p, id } = target.item;
    return [{ id: "open", label: "打开", enabled: true, run: () => io.open(p, id) }];
  }
  return itemMenu(target.item, target.isDir, io);
}

/**
 * 围栏标题的菜单（2026-09-13）。前两组是**这一栏自己的**（收起 / 高度），
 * 后面接上空白菜单那三组 —— 标题也是看板的一部分，右键它不该**少拿到**
 * 原本在空白处能拿到的东西。`fence_create` / `fence_paste` 本来就是桌面级的
 * （落点永远是桌面根，不是「某个围栏」），挂在这里语义与空白处完全一致。
 *
 * 当前高度写在父项标签里（`高度（3 行）` / `高度（自动）`），**不是**在子项上打勾：
 * `MenuItem` 里没有「勾选」这个字段，为它加一个会连带改渲染层与已录的菜单基线；
 * 而写在标签里零成本、一样看得见。
 */
function fenceMenu(
  t: { name: string; collapsed: boolean; rows: number },
  io: MenuIo
): MenuItem[] {
  const rows: MenuItem[] = [
    // 「自动」排第一：它是**默认**，也是「我调坏了，回到原样」的那个出口。
    { id: "rows-auto", label: "自动", enabled: true, run: () => io.setRows(t.name, 0) },
  ];
  for (let n = 1; n <= ROWS_MAX; n += 1) {
    rows.push({
      id: `rows-${n}`,
      label: `${n} 行`,
      enabled: true,
      run: () => io.setRows(t.name, n),
    });
  }
  return [
    {
      id: "collapse",
      // 标签写**动作**（点它会发生什么），不是状态 —— 与「显示桌面图标」那个按钮
      // 的念法不同，但那两个的语义本来就不一样：那个显示的是开关形参，
      // 这个显示的是「接下来会做什么」。收起时给「展开」，反之亦然。
      label: t.collapsed ? "展开" : "收起",
      enabled: true,
      run: () => io.setCollapsed(t.name, !t.collapsed),
    },
    {
      id: "rows",
      label: `高度（${t.rows > 0 ? `${t.rows} 行` : "自动"}）`,
      enabled: true,
      run: () => {},
      submenu: rows,
    },
    SEP,
    ...blankMenu(io),
  ];
}

function blankMenu(io: MenuIo): MenuItem[] {
  return [
    {
      id: "new",
      label: "新建",
      enabled: true,
      run: () => {},
      submenu: [
        { id: "new-folder", label: "文件夹", enabled: true, run: () => io.newItem("folder") },
        { id: "new-txt", label: "文本文档", enabled: true, run: () => io.newItem("txt") },
      ],
    },
    SEP,
    { id: "paste", label: "粘贴", enabled: true, run: () => io.paste() },
  ];
}

function itemMenu(item: FenceItem, isDir: boolean, io: MenuIo): MenuItem[] {
  const { path: p, id } = item;
  const out: MenuItem[] = [
    { id: "open", label: "打开", enabled: true, run: () => io.open(p, id) },
  ];
  if (!isDir) {
    out.push({ id: "open-with", label: "打开方式", enabled: true, run: () => io.openWith(p) });
  }
  out.push({
    id: "reveal",
    label: "在资源管理器中显示",
    enabled: true,
    run: () => io.reveal(p),
  });
  out.push(SEP);
  out.push({ id: "cut", label: "剪切", enabled: true, run: () => io.clipboard(p, true) });
  out.push({ id: "copy", label: "复制", enabled: true, run: () => io.clipboard(p, false) });
  out.push(SEP);
  out.push({ id: "rename", label: "重命名", enabled: true, run: () => io.rename(p) });
  out.push({ id: "delete", label: "删除", enabled: true, run: () => io.remove(p) });
  out.push(SEP);
  out.push({
    id: "send-to",
    label: "发送到",
    enabled: true,
    run: () => {},
    submenu: [
      {
        id: "send-to-lnk",
        label: "桌面快捷方式",
        enabled: true,
        run: () => io.sendTo(p),
      },
      { id: "send-to-zip", label: "压缩包", enabled: true, run: () => io.compress(p) },
    ],
  });
  out.push(SEP);
  out.push({ id: "properties", label: "属性", enabled: true, run: () => io.properties(p) });
  return out;
}

/**
 * 把菜单夹进视口。
 *
 * **入参出参全都是屏幕像素**（与 `clientX` / `getBoundingClientRect()` 同一个坐标系），
 * 不是 CSS 像素 —— 于是它跟缩放（`zoom` 1.28²）完全无关，可以脱离 DOM 单测。
 * 除以 Z 那一步由调用方在最后做。
 *
 * `margin` 也是屏幕像素。菜单比视口还大时贴左上角、绝不返回负坐标
 * （负坐标会让菜单跑到视口外面，比溢出更糟）。
 */
export function clampToViewport(
  at: { x: number; y: number },
  size: { w: number; h: number },
  view: { w: number; h: number },
  margin = 4
): { x: number; y: number } {
  const maxX = Math.max(margin, view.w - size.w - margin);
  const maxY = Math.max(margin, view.h - size.h - margin);
  return {
    x: Math.max(margin, Math.min(at.x, maxX)),
    y: Math.max(margin, Math.min(at.y, maxY)),
  };
}

/**
 * 改名时补回扩展名。**这张表前后端各有一半，缺了它就会毁掉快捷方式**：
 *
 *   - `ops::fence_rename` 是**原样改名**（走 `ops::rename_in`）：给什么名字就是什么名字，
 *     它不补扩展名。
 *   - 而看板上文件的 `label` **已经掉了扩展名**（`fence::index` 派生 `label` 处：`Cursor.lnk` → `Cursor`）。
 *
 * 所以「把 Cursor 改成 记事本」如果不补 `.lnk`，结果是桌面多一个**没有扩展名的文件**，
 * 双击它什么都不会发生。旧名必须从 `item.path` 的 basename 取 —— 那里才有扩展名。
 *
 * 规则与 `ops::split_name`**同一条**：开头的点是名字的一部分，不是扩展名
 * （`.gitignore`）。用户自己打了扩展名就原样放行，不重复叠一层
 * —— 与 `ops::with_ext`（「输入 `简历.txt` 不该变成 `简历.txt.txt`」）对称。
 *
 * 返回空串表示「用户没输入」，调用方据此当成取消。
 */
export function withPreservedExtension(oldFileName: string, input: string): string {
  const name = input.trim();
  if (!name) return "";
  const oldDot = oldFileName.lastIndexOf(".");
  if (oldDot <= 0) return name; // 旧名本来就没有扩展名，或开头的点不是扩展名
  if (name.indexOf(".") > 0) return name; // 用户自己打了扩展名
  return name + oldFileName.slice(oldDot);
}

/** 路径最后一段。`C:\Desktop\Cursor.lnk` → `Cursor.lnk`；两种分隔符都认。 */
export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i < 0 ? path : path.slice(i + 1);
}
