import { describe, expect, it } from "vitest";
import {
  baseName,
  clampToViewport,
  contextMenuModel,
  isSeparator,
  SEP_ID,
  targetFor,
  withPreservedExtension,
  type MenuIo,
  type MenuItem,
  type MenuTarget,
} from "./contextMenuModel";
import type { FenceItem } from "./model";

/** 记录调用的端口。菜单的行为合同就是「点了这项调到哪个命令、参数是什么」，全在这上面。 */
function spyIo() {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const io: MenuIo = {
    open: rec("open"),
    openWith: rec("openWith"),
    reveal: rec("reveal"),
    newItem: rec("newItem"),
    clipboard: rec("clipboard"),
    paste: rec("paste"),
    rename: rec("rename"),
    remove: rec("remove"),
    sendTo: rec("sendTo"),
    compress: rec("compress"),
    properties: rec("properties"),
  };
  return { io, calls };
}

const fileItem: FenceItem = {
  id: "user:Cursor.lnk",
  label: "Cursor",
  path: "C:\\Desktop\\Cursor.lnk",
  icon: null,
  isDir: false,
};
const dirItem: FenceItem = {
  id: "user:下载",
  label: "下载",
  path: "C:\\Desktop\\下载",
  icon: null,
  isDir: true,
};
/** 系统项在后端也是 `is_dir: true`（它们确实是 shell 文件夹）—— 刻意带上，
    钉住「sys 分支先于 isDir 分支」这条顺序。 */
const sysItem: FenceItem = {
  id: "sys-recycle",
  label: "回收站",
  path: "shell:RecycleBinFolder",
  icon: null,
  isDir: true,
};

/** 菜单里所有项（含子菜单），顺序即渲染顺序。 */
function flat(items: MenuItem[]): MenuItem[] {
  return items.flatMap((i) => (i.submenu ? [i, ...i.submenu] : [i]));
}

/** 按 id 找项并 run。找不到就抛 —— 免得「项不存在」被当成「断言通过」。 */
function run(items: MenuItem[], id: string) {
  const hit = flat(items).find((i) => i.id === id);
  if (!hit) throw new Error(`菜单里没有 id=${id}`);
  hit.run();
}

const ids = (items: MenuItem[]) => items.map((i) => i.id);

describe("targetFor", () => {
  it("sys- 前缀走 sys 分支，其余带 isDir", () => {
    expect(targetFor(sysItem)).toEqual({ kind: "sys", item: sysItem });
    expect(targetFor(dirItem)).toEqual({ kind: "item", item: dirItem, isDir: true });
    expect(targetFor(fileItem)).toEqual({ kind: "item", item: fileItem, isDir: false });
  });
});

describe("空白处", () => {
  it("只有 新建 ▸ 与 粘贴", () => {
    const { io } = spyIo();
    const m = contextMenuModel({ kind: "blank" }, io);
    expect(ids(m)).toEqual(["new", SEP_ID, "paste"]);
    expect(ids(m[0].submenu!)).toEqual(["new-folder", "new-txt"]);
  });

  it("新建的两项各自打到 newItem 的正确 kind", () => {
    const { io, calls } = spyIo();
    const m = contextMenuModel({ kind: "blank" }, io);
    run(m, "new-folder");
    run(m, "new-txt");
    expect(calls).toEqual([
      ["newItem", "folder"],
      ["newItem", "txt"],
    ]);
  });

  it("粘贴打到 paste", () => {
    const { io, calls } = spyIo();
    run(contextMenuModel({ kind: "blank" }, io), "paste");
    expect(calls).toEqual([["paste"]]);
  });

  it("**没有**「快捷方式」—— 空白处没有 target，后端会明确报错（ops.rs:209）", () => {
    const { io, calls } = spyIo();
    const m = contextMenuModel({ kind: "blank" }, io);
    expect(flat(m).map((i) => i.id)).not.toContain("new-lnk");
    // 也不能有任何一项偷偷调 newItem("lnk")
    flat(m).forEach((i) => i.run());
    expect(calls.some(([n, a]) => n === "newItem" && a === "lnk")).toBe(false);
  });
});

describe("文件", () => {
  const build = () => {
    const { io, calls } = spyIo();
    return { m: contextMenuModel({ kind: "item", item: fileItem, isDir: false }, io), calls };
  };

  it("完整分组与顺序", () => {
    expect(ids(build().m)).toEqual([
      "open",
      "open-with",
      "reveal",
      SEP_ID,
      "cut",
      "copy",
      SEP_ID,
      "rename",
      "delete",
      SEP_ID,
      "send-to",
      SEP_ID,
      "properties",
    ]);
    expect(ids(build().m[10].submenu!)).toEqual(["send-to-lnk", "send-to-zip"]);
  });

  it("每一项都打到正确的命令与参数", () => {
    const { m, calls } = build();
    for (const id of [
      "open",
      "open-with",
      "reveal",
      "cut",
      "copy",
      "rename",
      "delete",
      "send-to-lnk",
      "send-to-zip",
      "properties",
    ]) {
      run(m, id);
    }
    const p = fileItem.path;
    expect(calls).toEqual([
      // 「打开」带上 id：面板的 doLaunch(path, id) 靠它把这次启动记进「最近」。
      ["open", p, fileItem.id],
      ["openWith", p],
      ["reveal", p],
      ["clipboard", p, true],
      ["clipboard", p, false],
      ["rename", p],
      ["remove", p],
      ["sendTo", p],
      ["compress", p],
      ["properties", p],
    ]);
  });
});

describe("目录", () => {
  const m = contextMenuModel({ kind: "item", item: dirItem, isDir: true }, spyIo().io);
  const got = flat(m).map((i) => i.id);

  it("不给「打开方式」（文件夹没有打开方式，资源管理器也不给）", () => {
    expect(got).not.toContain("open-with");
  });

  it("「属性」「压缩」照给 —— 目录才是压缩的常见对象", () => {
    expect(got).toContain("properties");
    expect(got).toContain("send-to-zip");
  });

  it("不给「新建 ▸ / 粘贴」—— 那两个命令落点是桌面，挂在目录上会骗用户", () => {
    expect(got).not.toContain("new");
    expect(got).not.toContain("paste");
  });

  it("其余与文件一致，且顺序不变", () => {
    expect(ids(m)).toEqual([
      "open",
      "reveal",
      SEP_ID,
      "cut",
      "copy",
      SEP_ID,
      "rename",
      "delete",
      SEP_ID,
      "send-to",
      SEP_ID,
      "properties",
    ]);
  });
});

describe("sys 目标", () => {
  it("只留「打开」（spec §7.4），即使 is_dir 为真", () => {
    const { io, calls } = spyIo();
    const m = contextMenuModel({ kind: "sys", item: sysItem }, io);
    expect(ids(m)).toEqual(["open"]);
    run(m, "open");
    expect(calls).toEqual([["open", "shell:RecycleBinFolder", "sys-recycle"]]);
  });

  it("「属性」「打开方式」「压缩」一个都不在", () => {
    const got = flat(contextMenuModel({ kind: "sys", item: sysItem }, spyIo().io)).map(
      (i) => i.id
    );
    for (const forbidden of ["properties", "open-with", "send-to-zip", "rename", "delete"]) {
      expect(got, `sys 上不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("整个菜单的形状不变量", () => {
  const all: MenuTarget[] = [
    { kind: "blank" },
    { kind: "item", item: fileItem, isDir: false },
    { kind: "item", item: dirItem, isDir: true },
    { kind: "sys", item: sysItem },
  ];

  it("非分隔线的 id 不重复（重复会让 data-menu-id 选择器指到两个元素）", () => {
    for (const t of all) {
      const real = flat(contextMenuModel(t, spyIo().io)).filter((i) => !isSeparator(i));
      expect(new Set(real.map((i) => i.id)).size, `${t.kind} 有重复 id`).toBe(real.length);
    }
  });

  it("每一项都有非空 label（分隔线除外）", () => {
    for (const t of all) {
      for (const i of flat(contextMenuModel(t, spyIo().io))) {
        if (isSeparator(i)) expect(i.label).toBe("");
        else expect(i.label, `${t.kind}/${i.id} 没有 label`).not.toBe("");
      }
    }
  });

  it("今天**没有任何**目标产出 enabled:false 的普通项（可用性一律用隐藏表达）", () => {
    for (const t of all) {
      for (const i of flat(contextMenuModel(t, spyIo().io))) {
        if (!isSeparator(i)) expect(i.enabled, `${t.kind}/${i.id}`).toBe(true);
      }
    }
  });

  it("分隔线不夹在开头/结尾，也不连着两条", () => {
    for (const t of all) {
      const m = contextMenuModel(t, spyIo().io);
      expect(isSeparator(m[0]), `${t.kind} 开头就是分隔线`).toBe(false);
      expect(isSeparator(m[m.length - 1]), `${t.kind} 结尾是分隔线`).toBe(false);
      for (let i = 1; i < m.length; i += 1) {
        expect(isSeparator(m[i]) && isSeparator(m[i - 1]), `${t.kind} 有连续分隔线`).toBe(false);
      }
    }
  });
});

describe("clampToViewport", () => {
  const view = { w: 1280, h: 800 };
  const size = { w: 200, h: 300 };

  it("放得下就原地不动", () => {
    expect(clampToViewport({ x: 400, y: 300 }, size, view)).toEqual({ x: 400, y: 300 });
  });

  it("右下角溢出 → 往回收", () => {
    expect(clampToViewport({ x: 1270, y: 795 }, size, view)).toEqual({
      x: 1280 - 200 - 4,
      y: 800 - 300 - 4,
    });
  });

  it("点在视口外（负坐标）→ 拉回 margin", () => {
    expect(clampToViewport({ x: -50, y: -50 }, size, view)).toEqual({ x: 4, y: 4 });
  });

  it("菜单比视口还大 → 贴左上角的 margin，绝不返回负坐标", () => {
    const huge = { w: 2000, h: 1200 };
    expect(clampToViewport({ x: 600, y: 400 }, huge, view)).toEqual({ x: 4, y: 4 });
  });

  it("刚好贴边不算溢出", () => {
    expect(clampToViewport({ x: 1076, y: 496 }, size, view)).toEqual({ x: 1076, y: 496 });
  });
});

describe("withPreservedExtension", () => {
  it("用户没打扩展名 → 补回旧的", () => {
    expect(withPreservedExtension("Cursor.lnk", "记事本")).toBe("记事本.lnk");
    expect(withPreservedExtension("报表.xlsx", "月报")).toBe("月报.xlsx");
  });

  it("用户自己打了扩展名 → 原样放行（不叠成 .txt.txt）", () => {
    expect(withPreservedExtension("Cursor.lnk", "记事本.lnk")).toBe("记事本.lnk");
    expect(withPreservedExtension("a.txt", "b.md")).toBe("b.md");
  });

  it("旧名本来没有扩展名 → 不补", () => {
    expect(withPreservedExtension("下载", "文档")).toBe("文档");
    // 开头的点是名字的一部分，不是扩展名 —— 与 ops::split_name（ops.rs:97）同一条规则
    expect(withPreservedExtension(".gitignore", "新名")).toBe("新名");
  });

  it("空白输入 → 空串（调用方当成取消）", () => {
    expect(withPreservedExtension("Cursor.lnk", "")).toBe("");
    expect(withPreservedExtension("Cursor.lnk", "   ")).toBe("");
  });

  it("两边 trim（后端 check_name 也 trim，这里对齐，免得提示词与结果不一致）", () => {
    expect(withPreservedExtension("Cursor.lnk", "  记事本  ")).toBe("记事本.lnk");
  });
});

describe("baseName", () => {
  it("反斜杠 / 正斜杠 / 没有分隔符", () => {
    expect(baseName("C:\\Desktop\\Cursor.lnk")).toBe("Cursor.lnk");
    expect(baseName("C:/Desktop/Cursor.lnk")).toBe("Cursor.lnk");
    expect(baseName("Cursor.lnk")).toBe("Cursor.lnk");
    expect(baseName("")).toBe("");
  });
});
