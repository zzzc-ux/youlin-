"use client";

export type WeatherCardData = {
  area?: string;
  current?: {
    condition: string;
    feelsLikeC: number;
    humidity: number;
    pressure: number;
    tempC: number;
    uvIndex?: number;
    visibilityKm: number;
    windDir: string;
    windKmph: number;
  };
  forecast?: {
    date: string;
    desc: string;
    maxC: number;
    minC: number;
    precipChance: number;
  }[];
  location?: string;
};

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const dayLabel = (date: string, index: number): string => {
  if (index === 0) return "今天";
  if (index === 1) return "明天";
  const day = new Date(`${date}T00:00:00`);
  return Number.isNaN(day.getTime()) ? date : WEEKDAY[day.getDay()];
};

const windLabel = (dir: string): string => {
  const map: Record<string, string> = {
    N: "北风", NNE: "东北偏北风", NE: "东北风", ENE: "东北偏东风",
    E: "东风", ESE: "东南偏东风", SE: "东南风", SSE: "东南偏南风",
    S: "南风", SSW: "西南偏南风", SW: "西南风", WSW: "西南偏西风",
    W: "西风", WNW: "西北偏西风", NW: "西北风", NNW: "西北偏北风",
  };
  return map[dir] ?? dir;
};

export function WeatherCard({ weather }: { weather: WeatherCardData }) {
  const current = weather.current;

  if (!current) {
    return (
      <div className="glass w-fit rounded-xl px-3.5 py-2.5 text-[13px] text-foreground/70">
        没有查到「{weather.location}」的天气
      </div>
    );
  }

  return (
    <div className="glass w-full max-w-[420px] rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[12px] text-foreground/55">
            {weather.area || weather.location}
          </p>
          <p className="mt-1 flex items-baseline gap-2">
            <span className="text-[34px] font-semibold leading-none tracking-tight text-foreground">
              {current.tempC}
              <span className="text-[18px]">°C</span>
            </span>
            <span className="text-[13.5px] font-medium text-foreground/80">
              {current.condition}
            </span>
          </p>
        </div>
        <p className="shrink-0 pt-1 text-[12px] text-foreground/55">
          体感 {current.feelsLikeC}°C
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-foreground/55">
        <span>{windLabel(current.windDir)} {current.windKmph} km/h</span>
        <span>湿度 {current.humidity}%</span>
        <span>能见度 {current.visibilityKm} km</span>
        <span>气压 {current.pressure} hPa</span>
      </div>

      {weather.forecast && weather.forecast.length > 0 ? (
        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-black/[0.06] pt-3 dark:border-white/10">
          {weather.forecast.map((day, index) => (
            <div key={day.date}>
              <p className="text-[11px] text-foreground/50">
                {dayLabel(day.date, index)}
              </p>
              <p className="mt-0.5 line-clamp-1 text-[12px] font-medium text-foreground/85">
                {day.desc}
              </p>
              <p className="mt-0.5 text-[11.5px] text-foreground/60">
                {day.minC}° / {day.maxC}°
              </p>
              {day.precipChance > 20 ? (
                <p className="text-[10.5px] text-blue-500 dark:text-blue-300">
                  降水概率 {day.precipChance}%
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <p className="mt-2.5 text-[10.5px] text-foreground/40">数据来源 wttr.in</p>
    </div>
  );
}
