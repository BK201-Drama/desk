/**
 * 看板布局 — presentation 层
 * slot 容器供 infrastructure/host registry 挂载插件（vanilla 或 React）
 */
export function BoardLayout() {
  return (
    <div className="board" id="board" data-testid="desk-board">
      <section className="pane-info" id="slot-left" data-testid="slot-left" />
      <section className="pane-fences-host" id="slot-right" data-testid="slot-right" />
      <div id="slot-overlay" className="slot-overlay" data-testid="slot-overlay" />
    </div>
  );
}
