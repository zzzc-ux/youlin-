import type { Bulletin, BulletinCategory } from "./bulletins";

/**
 * 缺图条目的配图兜底。
 *
 * 这里刻意放在代码里而不是写回数据库：
 * 1. 种子数据本来就不在库里；
 * 2. 外部新闻的图片字段由抓取脚本生成，人工补图写回库里会在下次同步时被覆盖；
 * 3. 所有图都在 public/bulletins/ai，走静态资源，不需要代理。
 */

/**
 * 已经人工配过 AI 图的已审核新闻，按标题关键词匹配。
 * 不用 id：重建数据库或重新同步后 UUID 会变，标题才是稳定的锚点。
 */
const NEWS_COVER_RULES = [
  { cover: "/bulletins/ai/news-fire-safety.jpg", keyword: "消防宣传进校园" },
  { cover: "/bulletins/ai/news-singing.jpg", keyword: "同台竞唱" },
  { cover: "/bulletins/ai/news-overseas.jpg", keyword: "海外办学" },
  { cover: "/bulletins/ai/news-zero-carbon.jpg", keyword: "零碳校园" },
];

/** 板块级兜底：之后新审核进来、还没单独配图的条目至少不会退回纯文字卡 */
const CATEGORY_COVERS: Record<BulletinCategory, string> = {
  快报: "/bulletins/ai/kb-tushuguan-zuowei.jpg",
  思政: "/bulletins/ai/fallback-sizheng.jpg",
  热点: "/bulletins/ai/rd-jiuye-zhengce.jpg",
};

/** 有图用原图；没有就按标题 / 板块依次兜底 */
export function bulletinCover(item: Bulletin): string | undefined {
  if (item.image) {
    return item.image;
  }
  const matched = NEWS_COVER_RULES.find((rule) =>
    item.title.includes(rule.keyword)
  );
  return matched?.cover ?? CATEGORY_COVERS[item.category];
}
