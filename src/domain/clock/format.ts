import { pad } from "../../host/util";

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
