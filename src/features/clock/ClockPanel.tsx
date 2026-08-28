import { useEffect, useState } from "react";
import { formatClockDate, formatClockTime } from "../../domain/clock";
import "../../plugins/clock/panel.css";

export function ClockPanel() {
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

export default ClockPanel;
