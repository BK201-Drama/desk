/**
 * 「最近」那一行的全部渲染。外部只传数据与回调。
 *
 * ⚠️ **DOM 必须逐字节等于重构前 `FencePanel` 里那段 `<AppButton>` 的输出。**
 * 样式挂在 `panel.css` 上（Task 17 之前挂在 `styles.css`），其中三条依赖这里的结构：
 *
 *   | 选择器 | 依赖 |
 *   |---|---|
 *   | `#fenceRecent .fence-grid { --fence-rows: 1 }` | 必须有 `.fence-grid` 这一层 |
 *   | `#fenceRecent`（含暗色那一份） | 这个元素要么不存在、要么完整可见（见下） |
 *   | `.fence-app` / `.face` / `.label` | 三层结构不能少 |
 *
 * 表里**故意不写行号**：以前这一列写着 `panel.css:494 / 500 / 577`，而删掉那条死的
 * `:not([hidden])` 之前，它们实际已经在 480 / 486 / 563 了 —— 行号会漂，选择器不会。
 * 定位请照上面的选择器搜。
 *
 * 换句话说：这里的 className 少一个、层级差一层，观感就变了。而
 * `e2e/style-audit.spec.ts` 会当场红 —— 所以改这里之后
 * **必须**跑 `npm run test:style`，且期望是 **0 处漂移**。
 * 空的时候返回 null（不是返回一个空 div）—— 旧代码是 `recents.length > 0 ? … : null`，
 * 空 div 会让 `#fenceRecent` 一直存在，`.fence` 的圆角边框就露出来了。
 *
 * 2026-09-14：这里原本写「元素**不能带 `hidden` 属性**」，配着 panel.css 里一条
 * `#fenceRecent[hidden] { display: none !important }`。两个条件都是死的 —— 那条规则
 * **永远不会匹配**（这个组件要么不渲染、要么渲染出的 div 没有 `hidden`），而它旁边
 * 的 `:not([hidden])` 因此**恒真**。两条一起删了，契约简化成一句：
 * **不存在，或者存在且可见** —— 没有「存在但隐藏」这个第三态。
 */
import type { FenceItem } from "../model";
import { fenceIconStyle } from "../iconStyle";
import type { HostContext } from "../../../host/types";

export function RecentRow({
  ctx,
  items,
  onLaunch,
}: {
  ctx: HostContext;
  items: FenceItem[];
  onLaunch: (item: FenceItem) => void;
}) {
  if (!items.length) return null;
  return (
    <div id="fenceRecent" className="fence">
      <div className="fence-title" aria-label={`最近 ${items.length}`}>
        最近 <em>{items.length}</em>
      </div>
      <div className="fence-grid">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="fence-app"
            data-id={item.id}
            data-path={item.path}
            title={item.label}
            onClick={() => onLaunch(item)}
          >
            <div className="face" style={fenceIconStyle(ctx, item.icon, item.label)} />
            <span className="label">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
