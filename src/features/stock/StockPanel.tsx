import { useEffect } from "react";
import type { PluginComponentProps } from "../../host/types";
import { useStockQuotes } from "../../application/stock/useStockQuotes";
import {
  changeTone,
  formatChangePct,
  formatPrice,
} from "../../domain/stock";
import "../../plugins/stock/panel.css";

export function StockPanel({ ctx }: PluginComponentProps) {
  const { quotes, error, refresh } = useStockQuotes(ctx);

  useEffect(() => {
    return ctx.registerCommand({
      id: "refresh",
      title: "刷新行情",
      group: "股票",
      run: () => void refresh(),
    });
  }, [ctx, refresh]);

  return (
    <div className="stock-card" data-testid="stock-panel">
      <div className="stock-head">
        <span className="stock-label">行情</span>
      </div>
      {error ? (
        <div className="stock-error">{error}</div>
      ) : quotes.length === 0 ? (
        <div className="stock-empty">加载中…</div>
      ) : (
        <div className="stock-list">
          {quotes.map((q) => {
            const tone = changeTone(q.changePct);
            return (
              <div key={`${q.market}.${q.code}`} className="stock-row">
                <div className="stock-name" title={`${q.name} ${q.code}`}>
                  {q.name}
                </div>
                <div className={`stock-price is-${tone}`}>{formatPrice(q.price)}</div>
                <div className={`stock-chg is-${tone}`}>{formatChangePct(q.changePct)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default StockPanel;
