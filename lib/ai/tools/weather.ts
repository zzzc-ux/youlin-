import { tool } from "ai";
import { z } from "zod";
import { fetchWeather } from "@/lib/weather/wttr";

/**
 * 天气查询工具。
 *
 * 按项目先例（searchImages / searchNews）走 AI SDK tool() 直连数据源，
 * 不接 MCP：Vercel 函数起不了 stdio 子进程，remote MCP 只多一层协议。
 * 数据源 wttr.in 免 key，覆盖全球城市，中文描述由 lang=zh 提供。
 *
 * 用途边界：校园场景下用户问「明天穿什么」「现在下雨吗」「北京天气」
 * 这类实时天气问题时调用；不要用它回答与天气无关的问题。
 */

export type WeatherToolOutput =
  | { error: string; found: false }
  | {
      area: string;
      current: {
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
      found: boolean;
      forecast: {
        date: string;
        desc: string;
        maxC: number;
        minC: number;
        precipChance: number;
      }[];
      location: string;
      note?: string;
    };

const MAX_FORECAST_DAYS = 3;

export function weatherTools() {
  return {
    getWeather: tool({
      description:
        "查询某个城市的实时天气和未来 3 天预报（来源 wttr.in，覆盖全球）。用户问天气、气温、下不下雨、要不要带伞、穿什么衣服时调用。location 填城市名，中文英文都可以（如“北京”“Shanghai”）。数据属于外部气象服务，回答时可提示精度有限。",
      execute: async ({ location }): Promise<WeatherToolOutput> => {
        try {
          const result = await fetchWeather(location);

          return {
            area: result.area,
            current: {
              condition: result.current.condition,
              feelsLikeC: result.current.feelsLikeC,
              humidity: result.current.humidity,
              pressure: result.current.pressure,
              tempC: result.current.tempC,
              uvIndex: result.current.uvIndex,
              visibilityKm: result.current.visibilityKm,
              windDir: result.current.windDir,
              windKmph: result.current.windKmph,
            },
            found: true,
            forecast: result.forecast.slice(0, MAX_FORECAST_DAYS),
            location,
          };
        } catch (error) {
          return {
            error:
              error instanceof Error
                ? `天气查询失败：${error.message}`
                : "天气查询失败",
            found: false,
          };
        }
      },
      inputSchema: z.object({
        location: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .describe("城市名，如“北京”“武汉”“Tokyo”"),
      }),
    }),
  };
}
