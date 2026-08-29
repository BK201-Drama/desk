/** 领域层：命令面板常量 */

export const MAIN_PLUGINS = [
  "github",
  "token-capsule",
  "multica",
  "remind",
  "stock",
  "fence",
  "qq-music",
  "clock",
] as const;

export const EXTENDED_PLUGINS = ["ops-hud", "event-tape", "hello"] as const;

export const PLUGIN_LABEL: Record<string, string> = {
  github: "GitHub",
  "token-capsule": "Token 胶囊",
  multica: "Multica",
  remind: "待办",
  stock: "股票",
  fence: "围栏",
  "qq-music": "QQ 音乐",
  clock: "时钟",
  "ops-hud": "运维 HUD",
  "event-tape": "事件磁带",
  hello: "Hello",
};

export const QUICK_PRESETS = [
  { id: "coder", label: "程序员" },
  { id: "minimal", label: "极简" },
  { id: "fence", label: "围栏" },
] as const;
