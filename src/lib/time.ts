/** 跨面板时间格式（原 host.util.pad / domain.clock） */
export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export const CLOCK_DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export const CLOCK_MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
] as const;

export function formatClockTime(now: Date): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function formatClockDate(now: Date): string {
  return `${CLOCK_DAYS[now.getDay()]} · ${CLOCK_MONTHS[now.getMonth()]} ${now.getDate()}`;
}

export function formatSyncTime(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
