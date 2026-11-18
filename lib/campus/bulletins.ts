/**
 * 要闻栏的数据类型与版式工具。
 *
 * 注意：这个文件会被客户端组件 import，**不能引入数据库依赖**。
 * 读库的逻辑在 bulletins-store.ts，那边标了 server-only。
 */

export type BulletinCategory = "思政" | "热点" | "快报";

export type Bulletin = {
  id: string;
  category: BulletinCategory;
  title: string;
  /**
   * 缺省时自动走无图版式，不留占位框。
   * 站内路径（/bulletins/ai/...）视为本地封面；外部 http 地址走 /api/img-proxy 转发。
   * 前缀 /bulletins/ai/ 的图是模型生成的配图，卡片上会打「AI 配图」角标。
   */
  image?: string;
  /** 站内路径或外链；缺省时卡片不可点 */
  href?: string;
  publishedAt: string;
  source: string;
  /** 期号，思政类常用 */
  issue?: string;
  /** 区分种子数据和外部同步进来的新闻 */
  origin?: "seed" | "people";
};

export const bulletinCategories: BulletinCategory[] = ["思政", "热点", "快报"];

/**
 * 种子数据。同步失败、表为空或接口挂掉时，要闻栏靠它撑住，
 * 不会变成三个空白栏。同步进来的新闻一律追加在它们后面。
 */
export const seedBulletins: Bulletin[] = [
  {
    category: "思政",
    id: "sz-qingnian-daxuexi-24",
    image: "/bulletins/ai/sz-qingnian-daxuexi.jpg",
    issue: "第 24 期",
    origin: "seed",
    publishedAt: "2026-11-18 09:20",
    source: "校团委",
    title: "「青年大学习」新一期上线，各班团支书组织观看",
  },
  {
    category: "思政",
    id: "sz-gailun-beike",
    image: "/bulletins/ai/sz-gailun-beike.jpg",
    issue: "第 12 期",
    origin: "seed",
    publishedAt: "2026-11-17 15:00",
    source: "校党委宣传部",
    title: "「概论」课集体备课会，把四史案例编进 12 个专题",
  },
  {
    category: "思政",
    id: "sz-hongqiqu",
    image: "/bulletins/ai/sz-hongqiqu.jpg",
    issue: "第 11 期",
    origin: "seed",
    publishedAt: "2026-11-10 10:30",
    source: "马克思主义学院",
    title: "师生赴红旗渠实践教学，走了 3 天 27 公里",
  },
  {
    category: "热点",
    id: "rd-lengkongqi",
    image: "/bulletins/ai/rd-lengkongqi.jpg",
    origin: "seed",
    publishedAt: "2026-11-18 07:40",
    source: "校气象站",
    title: "冷空气今夜到，明天最低 2℃，晾在楼下的衣服收一下",
  },
  {
    category: "热点",
    id: "rd-jiuye-zhengce",
    image: "/bulletins/ai/rd-jiuye-zhengce.jpg",
    origin: "seed",
    publishedAt: "2026-11-17 18:20",
    source: "新华社",
    title: "高校毕业生就业创业政策有调整，这三条和你直接相关",
  },
  {
    category: "热点",
    id: "rd-shiyanshi-anquan",
    image: "/bulletins/ai/rd-shiyanshi-anquan.jpg",
    origin: "seed",
    publishedAt: "2026-11-16 11:05",
    source: "教育部网站",
    title: "实验室安全新规：危化品领用改为线上审批",
  },
  {
    category: "快报",
    id: "kb-tushuguan-zuowei",
    image: "/bulletins/ai/kb-tushuguan-zuowei.jpg",
    origin: "seed",
    publishedAt: "2026-11-18 10:00",
    source: "图书馆",
    title: "图书馆新开 200 个自习座位，今晚 22:00 起预约",
  },
  {
    category: "快报",
    id: "kb-sanshitang-chuangkou",
    image: "/bulletins/ai/kb-sanshitang.jpg",
    origin: "seed",
    publishedAt: "2026-11-18 08:10",
    source: "后勤处",
    title: "三食堂二楼 12 号窗口明天恢复供应",
  },
  {
    category: "快报",
    id: "kb-xiaoyunhui-jieli",
    image: "/bulletins/ai/kb-xiaoyunhui.jpg",
    origin: "seed",
    publishedAt: "2026-11-17 16:40",
    source: "体育部",
    title: "校运会 4×100 米接力，机械学院 42″7 破校纪录",
  },
];

/** 角标：有期号显示期号，当天显示「今天 09:20」，否则「11-17」 */
export function bulletinStamp(item: Bulletin): string {
  if (item.issue) {
    return item.issue;
  }
  const [datePart, timePart] = item.publishedAt.split(" ");
  const [year, month, day] = datePart.split("-");
  const now = new Date();
  const sameDay =
    now.getFullYear() === Number(year) &&
    now.getMonth() + 1 === Number(month) &&
    now.getDate() === Number(day);
  if (sameDay && timePart) {
    return `今天 ${timePart}`;
  }
  return `${month}-${day}`;
}

/**
 * 按「第几条」把三个板块对齐成组。
 *
 * 刻意不在这里排序：调用方已经按「种子在前、新闻在后」定好顺序，
 * 排序会把追加进来的新闻又插到种子前面，跟约定的展示顺序不符。
 * 只有凑满全部板块的组才返回，避免末组出现空格。
 */
export function groupBulletins(items: Bulletin[], size: number): Bulletin[][] {
  const byCategory = new Map<BulletinCategory, Bulletin[]>(
    bulletinCategories.map((category) => [category, []])
  );

  for (const item of items) {
    byCategory.get(item.category)?.push(item);
  }

  for (const list of byCategory.values()) {
    list.length = Math.min(list.length, size);
  }

  const groups: Bulletin[][] = [];
  for (let index = 0; index < size; index += 1) {
    const group = bulletinCategories
      .map((category) => byCategory.get(category)?.[index])
      .filter((item): item is Bulletin => item !== undefined);
    if (group.length === bulletinCategories.length) {
      groups.push(group);
    }
  }

  return groups;
}

/** 只用种子数据成组，页面首屏和接口失败时的兜底 */
export function listBulletinGroups(size = 3): Bulletin[][] {
  return groupBulletins(seedBulletins, size);
}
