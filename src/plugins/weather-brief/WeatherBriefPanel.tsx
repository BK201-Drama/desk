import { useCallback, useEffect, useState } from "react";
import type { PluginComponentProps } from "../../host/types";
import { isTextField } from "../../host/util";
import { useKeyboardInput } from "../../lib/useKeyboardInput";
import "./panel.css";

const STORAGE_KEY = "config";
const DEFAULT_CITY = "Shanghai";

type Config = { city: string };

type WeatherView = {
  city: string;
  temp: string;
  text: string;
};

const WMO: Record<number, string> = {
  0: "晴",
  1: "大部晴",
  2: "少云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  80: "阵雨",
  95: "雷阵雨",
};

async function fetchWeather(city: string): Promise<WeatherView> {
  const q = encodeURIComponent(city.trim() || DEFAULT_CITY);
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1&language=zh&format=json`
  );
  if (!geoRes.ok) throw new Error(`geocode HTTP ${geoRes.status}`);
  const geo = (await geoRes.json()) as {
    results?: Array<{ name: string; latitude: number; longitude: number; country?: string }>;
  };
  const hit = geo.results?.[0];
  if (!hit) throw new Error(`找不到城市「${city}」`);

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}` +
    `&longitude=${hit.longitude}&current=temperature_2m,weather_code&timezone=auto`;
  const wxRes = await fetch(url);
  if (!wxRes.ok) throw new Error(`forecast HTTP ${wxRes.status}`);
  const wx = (await wxRes.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
  };
  const tempN = wx.current?.temperature_2m;
  const code = wx.current?.weather_code ?? -1;
  const label = hit.country ? `${hit.name}` : hit.name;
  return {
    city: label,
    temp: Number.isFinite(tempN) ? `${Math.round(tempN!)}°` : "—",
    text: WMO[code] ?? "天气",
  };
}

function WeatherBriefPanel({ ctx }: PluginComponentProps) {
  const setKeyboard = useKeyboardInput(ctx);
  const [cfg, setCfg] = useState<Config>({ city: DEFAULT_CITY });
  const [view, setView] = useState<WeatherView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(DEFAULT_CITY);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const stored = await ctx.storage.get<Config>(STORAGE_KEY);
    const city = stored?.city?.trim() || DEFAULT_CITY;
    setCfg({ city });
    setDraft(city);
    setBusy(true);
    setErr(null);
    try {
      setView(await fetchWeather(city));
    } catch (e) {
      setView(null);
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [ctx]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return ctx.registerCommand({
      id: "refresh",
      title: "刷新天气",
      group: "天气",
      run: () => void load(),
    });
  }, [ctx, load]);

  const saveCity = async () => {
    const city = draft.trim() || DEFAULT_CITY;
    await ctx.storage.set(STORAGE_KEY, { city });
    setCfg({ city });
    setEditing(false);
    void setKeyboard(false);
    setBusy(true);
    setErr(null);
    try {
      setView(await fetchWeather(city));
    } catch (e) {
      setView(null);
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wb-card" data-testid="weather-brief-panel">
      {editing ? (
        <div className="wb-edit">
          <input
            className="wb-input"
            value={draft}
            placeholder="城市（英文或中文）"
            autoComplete="off"
            spellCheck={false}
            onFocus={() => void setKeyboard(true)}
            onBlur={() => {
              window.setTimeout(() => {
                if (!isTextField(document.activeElement)) void setKeyboard(false);
              }, 0);
            }}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void saveCity();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDraft(cfg.city);
                setEditing(false);
                void setKeyboard(false);
              }
            }}
          />
          <button type="button" className="wb-btn" onClick={() => void saveCity()}>
            保存
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="wb-row"
          title="点击改城市"
          onClick={() => {
            setDraft(cfg.city);
            setEditing(true);
          }}
        >
          <span className="wb-main">
            {busy
              ? "天气…"
              : err
                ? err
                : view
                  ? `${view.city} · ${view.temp} ${view.text}`
                  : "天气"}
          </span>
        </button>
      )}
    </div>
  );
}

export default WeatherBriefPanel;
