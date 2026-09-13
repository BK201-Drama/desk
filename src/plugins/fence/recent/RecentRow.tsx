/**
 * 「最近」那一行的全部渲染。外部只传数据与回调。
 *
 * ⚠️ **DOM 必须逐字节等于重构前 `FencePanel` 里那段 `<AppButton>` 的输出。**
 * 三条 `panel.css` 规则依赖这里结构（**故意不写行号** —— 行号会漂、选择器不会，按选择器搜）：
 *   · `#fenceRecent .fence-grid { --fence-rows: 1 }` 要有 `.fence-grid` 这一层；
 *   · `.fence-app` / `.face` / `.label` 三层不能少；
 *   · `#fenceRecent` 要满足下面的契约。
 *
 * 空的时候 `return null`，**不是**返回空 div：空 div 会让 `#fenceRecent` 一直存在，
 * 而 `.fence` 的圆角边框就露出来了 —— 契约是**「不存在，或者存在且可见」**，没有第三态。
 * className 少一个、层级差一层，`e2e/style-audit.spec.ts` 会当场红 ——
 * 所以改这里**必须**跑 `npm run test:style`，期望 **0 处漂移**。
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
