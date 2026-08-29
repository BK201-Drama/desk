import { useEffect, useState } from "react";
import type { PluginModule } from "../../host/types";
import { formatClockDate, formatClockTime } from "./model";
import "./panel.css";

function ClockPanel() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="desk-clock" data-testid="clock-panel">
      <div className="clock-time">{formatClockTime(now)}</div>
      <div className="clock-date">{formatClockDate(now)}</div>
    </div>
  );
}

const panel: PluginModule = {
  Component: ClockPanel,
};

export default panel;
