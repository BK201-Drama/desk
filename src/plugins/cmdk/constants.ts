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
  // `sys-res` 默认被三套预设都列入 disabled，所以它**只能**待在 MAIN：
  // `navLogic` 里 MAIN 是无条件全列的，EXTENDED 会被 `disabledIds` 过滤掉。
  // 放进 EXTENDED 的后果不是「默认收起」，是**面板做完了却没有任何入口打开它**。
  "sys-res",
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
  "sys-res": "系统资源",
  "ops-hud": "运维 HUD",
  "event-tape": "事件磁带",
  hello: "Hello",
};
