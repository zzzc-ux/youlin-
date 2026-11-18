/**
 * 论坛演示数据种子脚本
 * 用法：pnpm tsx scripts/seed-forum-demo.ts
 * 说明：直接写入 ForumPost / ForumComment，userId 使用随机 UUID（非当前登录用户），
 *      因此不影响"我发布的"判定；帖子时间分布在最近 7 天内，营造活跃氛围。
 *      已存在同标题帖子时跳过，可重复执行。
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "@/lib/db/client";
import { ensureForum } from "@/lib/campus/forum";
import { ensureForumComments } from "@/lib/campus/forum-comments";

type SeedComment = {
  author: string;
  body: string;
  /** 距帖子发布多少分钟后回复 */
  after: number;
};

type SeedPost = {
  author: string;
  category: string;
  title: string;
  body: string;
  place?: string | null;
  eventTime?: string | null;
  /** 距现在多少小时前发布 */
  hoursAgo: number;
  comments?: SeedComment[];
};

const posts: SeedPost[] = [
  // ===== 活动 =====
  {
    author: "青年志愿者协会",
    category: "活动",
    title: "周五东区操场捡跑一小时，来一起？",
    body: "边慢跑边捡垃圾，跑完发志愿服务时长。上周来了二十多个人，气氛很好，这次准备了手套和矿泉水。\n集合在东区操场南门，16:30 出发，下雨改到体育馆。",
    place: "东区操场",
    eventTime: "周五 16:30",
    hoursAgo: 30,
    comments: [
      { author: "南区碳水脑袋", body: "算我一个，手套要自己带吗？", after: 25 },
      { author: "青年志愿者协会", body: "不用带，我们准备了两箱，人来了就行。", after: 40 },
      { author: "阿岚", body: "上周去过了，组织得挺好的，这次继续。", after: 95 },
      { author: "熬夜冠军", body: "能不能稍微晚十分钟，最后一节课 16:20 才下课", after: 180 },
    ],
  },
  {
    author: "校篮球社",
    category: "活动",
    title: "院系友谊赛还缺 2 人，救救",
    body: "计科 vs 电信，周六 14:00 体育馆。我们队伤了一个，能打的来补位，位置不限。\n赛后管奶茶，输了也管。",
    place: "体育馆",
    eventTime: "周六 14:00",
    hoursAgo: 12,
    comments: [
      { author: "三分线外一米", body: "我可以打小前，之前院队打过两年", after: 15 },
      { author: "校篮球社", body: "来来来，周六提前二十分钟热身", after: 22 },
      { author: "图书馆常驻", body: "不会打能来看吗，当观众", after: 66 },
    ],
  },
  {
    author: "动漫社",
    category: "活动",
    title: "周末观影会《言叶之庭》，投影已就位",
    body: "周日晚 19:00 在活动中心 302，这次借到了新投影，画质比上次好很多。\n免费入场，自带零食，走的时候麻烦把垃圾带走。",
    place: "大学生活动中心 302",
    eventTime: "周日 19:00",
    hoursAgo: 52,
    comments: [
      { author: "Kiki", body: "想问下大概几点结束，怕赶不上末班车", after: 35 },
      { author: "动漫社", body: "片子 46 分钟，加上闲聊八点半前肯定散。", after: 48 },
      { author: "猫德学院在读", body: "上次放的《秒速五厘米》就很好看，这次还来", after: 200 },
    ],
  },
  {
    author: "学生会",
    category: "活动",
    title: "社团招新集中咨询，周四中午活动中心门口",
    body: "摄影、书法、机器人、志愿者协会都会在，可以当场填表报名。\n中午 11:30 到 13:30，路过顺手看一眼也行。",
    place: "大学生活动中心",
    eventTime: "周四 11:30-13:30",
    hoursAgo: 6,
    comments: [
      { author: "小胖不胖", body: "机器人协会招大一吗？零基础", after: 12 },
      { author: "学生会", body: "招的，他们本来就有新手班，每周三晚上。", after: 20 },
    ],
  },

  // ===== 讲座 =====
  {
    author: "图书馆读者服务",
    category: "讲座",
    title: "学术规范读书会：怎么引用文献不踩雷",
    body: "主要讲三件事：什么时候必须引用、查重报告怎么看、参考文献格式怎么统一。\n适合正在写课程论文和开题的同学，带电脑来可以现场改。",
    place: "图书馆报告厅",
    eventTime: "周三 19:00",
    hoursAgo: 20,
    comments: [
      { author: "论文写不出来", body: "开题的文献综述刚好卡住了，一定来", after: 30 },
      { author: "阿伟（重修中）", body: "需要提前报名吗还是直接去", after: 55 },
      { author: "图书馆读者服务", body: "直接来就行，座位先到先得，大概能坐一百人。", after: 70 },
    ],
  },
  {
    author: "就业指导中心",
    category: "讲座",
    title: "简历门诊：带一份简历来，改到能投为止",
    body: "一对一改简历，每位同学 15 分钟，重点看项目经历怎么写、量化数据怎么补。\n周五下午 14:00-17:00，就业中心二楼，现场取号。",
    place: "就业指导中心二楼",
    eventTime: "周五 14:00",
    hoursAgo: 44,
    comments: [
      { author: "秋招预备役", body: "大三实习简历能带来改吗", after: 40 },
      { author: "就业指导中心", body: "可以，实习和校招都改。", after: 52 },
      { author: "熬夜冠军", body: "五点半下课再去还来得及吗", after: 120 },
    ],
  },
  {
    author: "数模协会",
    category: "讲座",
    title: "数学建模入门分享，从零跑通第一个模型",
    body: "讲 Python 环境怎么装、常用的三个库、论文排版模板分享。\n零基础也能听懂，之前带过几届新生，最后都会跑出一个能出图的结果。",
    place: "教学楼 A305",
    eventTime: "周六 19:00",
    hoursAgo: 72,
    comments: [
      { author: "想拿奖的菜鸟", body: "电脑配置不高能跑吗，只有核显", after: 60 },
      { author: "数模协会", body: "能，入门的数据量很小，笔记本都行。", after: 88 },
    ],
  },

  // ===== 社团 =====
  {
    author: "摄影社",
    category: "社团",
    title: "周六日出扫街，带相机不带也行",
    body: "早上 6:40 图书馆门口集合，去老城区拍晨光和早市，大概拍两个小时。\n手机也能来，主要是练构图。回来一起在食堂吃早饭。",
    place: "图书馆门口",
    eventTime: "周六 6:40",
    hoursAgo: 15,
    comments: [
      { author: "阿岚", body: "起不来但想去，能不能改成七点", after: 18 },
      { author: "摄影社", body: "六点四十是为了抢光，七点太阳就硬了，下次可以约傍晚场。", after: 30 },
      { author: "宿舍楼下那只橘", body: "手机党报名，想问要交社费吗", after: 90 },
    ],
  },
  {
    author: "书法社",
    category: "社团",
    title: "练字教室这周开放，晚七点三楼",
    body: "毛笔和纸社里都有，来就行。这次讲一下横折钩的写法，被这个笔画折磨很久的可以来。\n周三到周五晚 19:00-21:00，活动中心 310。",
    place: "大学生活动中心 310",
    eventTime: "周三至周五 19:00",
    hoursAgo: 26,
    comments: [
      { author: "写字像鸡爪", body: "零基础会不会很尴尬", after: 20 },
      { author: "书法社", body: "一半都是零基础，没人会笑你，来了先练横。", after: 35 },
    ],
  },
  {
    author: "机器人协会",
    category: "社团",
    title: "招新 + 开源小车试玩，可以上手开",
    body: "这次带了三台自己做的循迹小车，现场可以开，撞坏了也不用赔。\n每周三晚上有新手班，从焊接到写代码一步步来，不要求基础。",
    place: "工程训练中心 108",
    eventTime: "周四 12:00",
    hoursAgo: 96,
    comments: [
      { author: "小胖不胖", body: "文科生能加吗，纯好奇", after: 44 },
      { author: "机器人协会", body: "能，我们社里就有两个文科的，负责写文案和拍视频。", after: 60 },
    ],
  },
  {
    author: "吉他社",
    category: "社团",
    title: "草坪夜弹，欢迎来唱",
    body: "周五晚上八点，图书馆后面的草坪，带了两把吉他和一个音箱。\n想唱什么可以在下面说，会弹的就伴奏，不会唱来听也行。",
    place: "图书馆后草坪",
    eventTime: "周五 20:00",
    hoursAgo: 8,
    comments: [
      { author: "Kiki", body: "能点《晴天》吗", after: 9 },
      { author: "吉他社", body: "必须能，这个是保留曲目。", after: 14 },
      { author: "熬夜冠军", body: "有人带尤克里里吗，我也想去凑一个", after: 40 },
    ],
  },

  // ===== 招领 =====
  {
    author: "校园同学",
    category: "招领",
    title: "招领：东区食堂二楼捡到一副黑框眼镜",
    body: "今天中午在东区食堂二楼靠窗的位置捡到的，黑框，镜片有一点划痕。\n已经放在食堂二楼收餐台旁边的失物筐里，失主可以自己去拿，或者回帖说一声我帮你带过去。",
    place: "东区食堂二楼",
    hoursAgo: 5,
    comments: [
      { author: "找不到眼镜的人", body: "是不是左边镜腿有点松？我中午在那吃过饭", after: 20 },
      { author: "校园同学", body: "对，左边确实松，应该就是你的，去失物筐拿吧。", after: 26 },
    ],
  },
  {
    author: "校园同学",
    category: "招领",
    title: "招领：图书馆四楼窗边捡到蓝牙耳机",
    body: "白色充电仓，盖子有点磨损，在四楼靠窗第三个位置捡到的。\n放在图书馆一楼服务台了，说特征能对上就可以领。",
    place: "图书馆四楼",
    hoursAgo: 28,
    comments: [
      { author: "耳机掉了的人", body: "是不是右耳偶尔断连？", after: 60 },
    ],
  },
  {
    author: "校园同学",
    category: "招领",
    title: "招领：体育馆更衣室捡到学生卡（已交保卫处）",
    body: "下午打球时在更衣室长椅上捡到的，已经交到体育馆门口的保卫处值班室。\n失主带身份证去领就行。",
    place: "体育馆更衣室",
    hoursAgo: 50,
  },
  {
    author: "校园同学",
    category: "招领",
    title: "招领：南门快递站门口一串钥匙",
    body: "一串钥匙，上面有个小汽车钥匙和两个门禁扣，晚上七点多在快递站门口台阶上捡到的。\n还挂在快递站门口的失物板上，失主去认一下。",
    place: "南门快递站",
    hoursAgo: 70,
    comments: [
      { author: "丢钥匙的倒霉蛋", body: "我的！明天一早去拿，谢谢谢谢", after: 130 },
    ],
  },
  {
    author: "校园同学",
    category: "招领",
    title: "招领：教学楼 B203 白色水杯",
    body: "白色保温杯，杯身贴了一张小熊贴纸，昨天下午课后落在 B203 最后一排。\n现在在 B 栋一楼值班室。",
    place: "教学楼 B203",
    hoursAgo: 100,
  },

  // ===== 求助 =====
  {
    author: "论文写不出来",
    category: "求助",
    title: "周末哪里能打印 A3，救命",
    body: "要打两张 A3 的图纸，问了三家店周末都关门，学校里的自助打印机只能 A4。\n有没有人知道校门口哪家周六开门的？",
    hoursAgo: 3,
    comments: [
      { author: "打印店常客", body: "南门出去左转第二家，周六上午开到十一点半，刚在那打过。", after: 8 },
      { author: "论文写不出来", body: "太好了，明早去，谢谢！", after: 12 },
      { author: "阿伟（重修中）", body: "图书馆一楼的自助机好像能打 A3，不过要自己带纸", after: 35 },
    ],
  },
  {
    author: "表带断了",
    category: "求助",
    title: "求推荐靠谱的修表店，表带断了",
    body: "手表的表带在接口处断了，是皮带的，不想换整条。\n有没有修过表的同学推荐一下，最好别太贵。",
    hoursAgo: 16,
    comments: [
      { author: "老校区土著", body: "西门老街那家修了二十年表，换表带三十块，人很实在。", after: 25 },
      { author: "表带断了", body: "记下了，周末去看看", after: 40 },
    ],
  },
  {
    author: "焊接小工",
    category: "求助",
    title: "借个电烙铁用一晚上，请喝奶茶",
    body: "做课设要焊一块小板子，就差电烙铁了，社里的要排队。\n借一晚上，用完擦干净还，奶茶随便点。",
    hoursAgo: 9,
    comments: [
      { author: "小胖不胖", body: "我有一把，恒温的，周四晚上给你？", after: 15 },
      { author: "焊接小工", body: "可以可以，太感谢了，私信你", after: 18 },
    ],
  },
  {
    author: "体育废柴",
    category: "求助",
    title: "体测八百米怎么过，在线等挺急的",
    body: "下周三体测，上次跑了五分半，差一点及格。\n有没有什么临时抱佛脚的办法，现在每天晚上能跑二十分钟。",
    hoursAgo: 38,
    comments: [
      { author: "操场常客", body: "别猛跑，跟着比自己快一点的人，前四百稳住最后一百冲。", after: 22 },
      { author: "体育废柴", body: "感谢！明天就按这个跑", after: 30 },
      { author: "熬夜冠军", body: "千万别空腹跑，我们班有人跑完直接坐地上了", after: 95 },
    ],
  },
  {
    author: "剁手党本党",
    category: "求助",
    title: "谁知道快递站几点关门",
    body: "下班回宿舍都九点多了，快递站还开着吗？\n连续两天没取到，有点慌。",
    hoursAgo: 60,
    comments: [
      { author: "南区碳水脑袋", body: "南门那家到十点，东区的九点半就关了。", after: 10 },
      { author: "剁手党本党", body: "那我去南门，谢谢！", after: 15 },
    ],
  },

  // ===== 闲置 =====
  {
    author: "考研上岸了",
    category: "闲置",
    title: "出考研英语真题全套装，九成新",
    body: "黄皮书全套，近十年真题加解析，只做了前两套，后面都是新的。\n原价一百六，出六十，只限校内面交，西区宿舍楼下。",
    place: "西区宿舍",
    hoursAgo: 4,
    comments: [
      { author: "二战预备役", body: "还在吗？我今晚就能过来拿", after: 10 },
      { author: "考研上岸了", body: "还在，晚上八点西区宿舍门口", after: 14 },
    ],
  },
  {
    author: "搬宿舍的人",
    category: "闲置",
    title: "出小冰箱，搬宿舍急出",
    body: "单门小冰箱，用了一年多，制冷正常，就是门边有点划痕。\n一百五自提，东区 5 栋，帮抬下楼。",
    place: "东区 5 栋",
    hoursAgo: 22,
    comments: [
      { author: "宿舍楼下那只橘", body: "能便宜点吗，一百二我今天就来搬", after: 30 },
      { author: "搬宿舍的人", body: "一百三，能今天就搬的话", after: 38 },
    ],
  },
  {
    author: "毕业清仓",
    category: "闲置",
    title: "送两个纸箱，搬宿舍刚好用",
    body: "搬完东西剩下两个大纸箱，很结实，带盖。\n免费送，自己来南区 3 栋拿，今天没人要就扔了。",
    place: "南区 3 栋",
    hoursAgo: 34,
    comments: [
      { author: "阿岚", body: "我要！下午过去拿可以吗", after: 12 },
      { author: "毕业清仓", body: "可以，门牌号发你", after: 20 },
    ],
  },
  {
    author: "桌面太空了",
    category: "闲置",
    title: "收一个二手显示器，24 寸就行",
    body: "写代码用，能亮能显示就行，不求画质。\n预算三百以内，可以自己上门搬。",
    hoursAgo: 48,
    comments: [
      { author: "装机佬", body: "我这有台 24 寸的，三百给你，带 HDMI 线", after: 40 },
      { author: "桌面太空了", body: "型号发我看看？", after: 52 },
    ],
  },
  {
    author: "高数课代表",
    category: "闲置",
    title: "出线性代数教材，有笔记",
    body: "教材加一本习题册，笔记记得比较全，重点都标了。\n二十五块两本，图书馆门口面交。",
    place: "图书馆门口",
    hoursAgo: 84,
    comments: [
      { author: "重修第二次", body: "笔记能拍一页看看吗", after: 25 },
      { author: "高数课代表", body: "可以，我拍好回头发你", after: 33 },
    ],
  },
];

const OWNER = "00000000-0000-4000-8000-000000000001";

async function main() {
  await ensureForum();
  await ensureForumComments();
  const db = await createDatabase();

  let insertedPosts = 0;
  let insertedComments = 0;

  for (const post of posts) {
    const existing = await db.execute(
      sql`SELECT "id" FROM "ForumPost" WHERE "title" = ${post.title} LIMIT 1`
    );
    if (((existing as { rows?: unknown[] }).rows ?? []).length > 0) {
      continue;
    }
    const createdAt = new Date(Date.now() - post.hoursAgo * 3600_000);
    const rows = (
      (await db.execute(sql`
        INSERT INTO "ForumPost" ("userId","author","category","title","body","place","eventTime","createdAt")
        VALUES (${randomUUID()}, ${post.author}, ${post.category}, ${post.title}, ${post.body},
                ${post.place ?? null}, ${post.eventTime ?? null}, ${createdAt.toISOString()}::timestamp)
        RETURNING "id"
      `)) as { rows?: { id: string }[] }
    ).rows;
    const postId = rows?.[0]?.id;
    if (!postId) {
      continue;
    }
    insertedPosts += 1;
    for (const comment of post.comments ?? []) {
      const commentAt = new Date(createdAt.getTime() + comment.after * 60_000);
      if (commentAt.getTime() > Date.now()) {
        continue;
      }
      await db.execute(sql`
        INSERT INTO "ForumComment" ("postId","userId","author","body","createdAt")
        VALUES (${postId}, ${randomUUID()}, ${comment.author}, ${comment.body}, ${commentAt.toISOString()}::timestamp)
      `);
      insertedComments += 1;
    }
  }

  // 兜底：种子帖作者若不是"校园同学"也要保证 owner 字段有值（演示账号标识，不影响展示）
  void OWNER;

  console.log(`完成：新增帖子 ${insertedPosts} 条，评论 ${insertedComments} 条（已存在的标题自动跳过）`);
  process.exit(0);
}

main();
