import "server-only";

/**
 * wttr.in 数据层。
 *
 * 选型结论（2026-11-18 实测）：本机对 api.open-meteo.com 超时不可达，
 * 高德需 key 且只覆盖中国城市，wttr.in 免 key、JSON 结构稳定，故主源用它。
 * j1 格式返回 3 天预报 + 逐 3 小时时段；lang=zh 时天气描述会同时给出
 * lang_zh 数组，取不到再回退英文 weatherDesc。
 */

const ENDPOINT = "https://wttr.in";
const TIMEOUT_MS = 8000;

export type WeatherCurrent = {
  condition: string;
  feelsLikeC: number;
  humidity: number;
  observationTime: string;
  pressure: number;
  tempC: number;
  uvIndex?: number;
  visibilityKm: number;
  windDir: string;
  windKmph: number;
};

export type WeatherDay = {
  date: string;
  desc: string;
  maxC: number;
  minC: number;
  precipChance: number;
};

export type WeatherResult = {
  area: string;
  current: WeatherCurrent;
  forecast: WeatherDay[];
};

type WttrValue = { value: string };

interface WttrCurrent {
  cloudcover: number;
  FeelsLikeC: string;
  humidity: string;
  lang_zh?: WttrValue[];
  precipMM: string;
  pressure: string;
  temp_C: string;
  uvIndex?: string;
  visibility: string;
  weatherDesc: WttrValue[];
  winddir16Point: string;
  windspeedKmph: string;
  observation_time?: string;
}

interface WttrHourly {
  chanceofrain?: string;
  lang_zh?: WttrValue[];
  weatherDesc: WttrValue[];
}

interface WttrDay {
  astronomy?: { sunrise: string; sunset: string }[];
  date: string;
  hourly: WttrHourly[];
  maxtempC: string;
  mintempC: string;
}

interface WttrResponse {
  current_condition: WttrCurrent[];
  nearest_area?: {
    areaName: WttrValue[];
    country: WttrValue[];
    latitude: string;
    longitude: string;
    region: WttrValue[];
  }[];
  weather: WttrDay[];
}

const num = (raw: string | undefined, fallback = 0): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// wttr.in 的 lang=zh 对 j1 格式不生效，描述永远是英文，这里做一层常用词映射
const CONDITION_ZH: Record<string, string> = {
  clear: "晴",
  sunny: "晴",
  "partly cloudy": "多云",
  cloudy: "阴",
  overcast: "阴",
  "sunny interval": "多云间晴",
  "sunny intervals": "多云间晴",
  "light rain": "小雨",
  "moderate rain": "中雨",
  "heavy rain": "大雨",
  "light rain shower": "阵雨",
  "patchy rain possible": "可能有零星小雨",
  "patchy light rain": "零星小雨",
  "light drizzle": "毛毛雨",
  "patchy light drizzle": "零星毛毛雨",
  thunder: "雷阵雨",
  "thundery outbreaks possible": "可能有雷阵雨",
  "thundery outbreaks in nearby": "附近有雷阵雨",
  "moderate or heavy rain with thunder": "雷阵雨",
  snow: "雪",
  "light snow": "小雪",
  "moderate snow": "中雪",
  "heavy snow": "大雪",
  "light snow showers": "阵雪",
  "patchy snow possible": "可能有零星小雪",
  "blowing snow": "吹雪",
  sleet: "雨夹雪",
  "light sleet": "小阵雨夹雪",
  "light sleet showers": "雨夹雪",
  fog: "雾",
  "patchy fog": "局部有雾",
  mist: "薄雾",
  haze: "霾",
  "freezing fog": "冻雾",
  "blizzard": "暴风雪",
  "heavy rain shower": "强阵雨",
  "moderate or heavy rain shower": "强阵雨",
  "heavy snow showers": "强阵雪",
  "light showers of rain": "小阵雨",
  "torrential rain shower": "暴雨",
  "light rain and thunder": "小雨雷声",
  "moderate or heavy snow with thunder": "雷伴大雪",
  "ice pellets": "冰粒",
  "light ice pellets": "小冰粒",
  "patchy sleet possible": "可能有零星雨夹雪",
};

const zhCondition = (english: string): string => {
  const key = english.trim().toLowerCase();
  return CONDITION_ZH[key] ?? english;
};

const desc = (
  item: { lang_zh?: WttrValue[]; weatherDesc: WttrValue[] },
): string => {
  const raw =
    item.lang_zh?.[0]?.value ?? item.weatherDesc?.[0]?.value ?? "未知";
  return zhCondition(raw);
};

export async function fetchWeather(location: string): Promise<WeatherResult> {
  const url = `${ENDPOINT}/${encodeURIComponent(location)}?format=j1&lang=zh`;
  const response = await fetch(url, {
    headers: { "User-Agent": "curl/8.0.1" },
    // wttr.in 对无浏览器 UA 的请求偶发 302 到文本版，follow 后仍拿 JSON
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`wttr.in 返回 ${response.status}`);
  }

  const data = (await response.json()) as WttrResponse;
  const current = data.current_condition?.[0];
  if (!current) {
    throw new Error("wttr.in 未返回实况数据");
  }

  const area = data.nearest_area?.[0];
  const areaLabel = [area?.areaName?.[0]?.value, area?.region?.[0]?.value]
    .filter(Boolean)
    .join("，");

  const forecast: WeatherDay[] = (data.weather ?? []).slice(0, 3).map((day) => ({
    date: day.date,
    desc: desc(day.hourly?.[Math.floor(day.hourly.length / 2)] ?? { weatherDesc: [{ value: "未知" }] }),
    maxC: num(day.maxtempC),
    minC: num(day.mintempC),
    precipChance: Math.max(
      ...(day.hourly ?? []).map((h) => num(h.chanceofrain)),
      0,
    ),
  }));

  return {
    area: areaLabel || location,
    current: {
      condition: desc(current),
      feelsLikeC: num(current.FeelsLikeC),
      humidity: num(current.humidity),
      observationTime: current.observation_time ?? "",
      pressure: num(current.pressure),
      tempC: num(current.temp_C),
      uvIndex: current.uvIndex ? num(current.uvIndex) : undefined,
      visibilityKm: num(current.visibility),
      windDir: current.winddir16Point ?? "",
      windKmph: num(current.windspeedKmph),
    },
    forecast,
  };
}
