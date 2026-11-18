import { sql } from "drizzle-orm";
import { hasModelProvider } from "@/lib/ai/providers";
import { campusTools } from "@/lib/ai/tools/campus";
import { createDatabase } from "@/lib/db/client";
import type { CampusTraceStep } from "@/lib/types";
import {
  getOpenForumPostForLostItem,
  listForumPosts,
  searchForumPosts,
} from "./forum";
import { draftForumPostWithLLM } from "./forum-draft";
import { matchForumPostsWithLLM } from "./forum-match";
import type { ForumPost } from "./forum-shared";
import { type CampusKind, classifyCampus } from "./harness";
import { listOwnOpenItems } from "./lost-found";
import { redactPublicText } from "./privacy";

type ToolName = keyof ReturnType<typeof campusTools>;
type WriteTool = "registerLost" | "closeLost" | "createRepair" | "publishForum";
type Plan = {
  tool: WriteTool;
  args: Record<string, unknown>;
  description: string;
};
type HistoryItem = { role: string; text: string };
type ReportStep = (step: CampusTraceStep) => void;
export type CampusOutcome = {
  kind: CampusKind;
  kindLabel: string;
  tool: string;
  sources: string[];
  found: boolean;
  answer: string;
  evidence: string;
  pending?: boolean;
  forumPostId?: string;
  forumPostLabel?: string;
  forumPosts?: { id: string; title: string }[];
  suppressModel?: boolean;
};

// This is the single policy registry used by the chat execution path.
export const toolPolicy: Record<ToolName, "read" | "write"> = {
  campusCard: "read",
  closeLost: "write",
  createRepair: "write",
  publishForum: "write",
  queryAccess: "read",
  registerLost: "write",
  searchCampus: "read",
  searchForum: "read",
  searchLost: "read",
  searchNotice: "read",
  searchRepair: "read",
};

const labels: Record<CampusKind, string> = {
  access: "门禁查询",
  card: "校园卡服务",
  forum: "校园论坛",
  lost: "失物招领",
  notice: "校园通知",
  qa: "校园问答",
  repair: "宿舍报修",
  unknown: "未归类",
};
const sources: Partial<Record<ToolName, string>> = {
  closeLost: "校园失物招领库（本机记录）",
  createRepair: "宿舍报修样本记录",
  publishForum: "校园论坛（本机帖子）",
  registerLost: "校园失物招领库（本机记录）",
  searchForum: "校园论坛（本机帖子）",
  searchLost: "校园失物招领库（本机记录）",
  searchRepair: "宿舍报修样本记录",
};
const categories = [
  "校园卡",
  "学生卡",
  "一卡通",
  "书包",
  "钥匙",
  "水杯",
  "耳机",
  "电脑",
  "雨伞",
  "身份证",
  "钱包",
  "手机",
  "课本",
];
const places = [
  "图书馆",
  "食堂",
  "教学楼",
  "操场",
  "宿舍",
  "体育馆",
  "快递站",
  "东区",
  "西区",
];
const repairItems = [
  "水龙头",
  "空调",
  "门锁",
  "窗户",
  "网络",
  "插座",
  "暖气",
  "灯",
];

export function routeCampus(
  text: string,
  history: HistoryItem[]
): { kind: CampusKind; query: string } {
  const kind = classifyCampus(text);
  if (kind !== "unknown") {
    return { kind, query: text };
  }
  // 失物主题续接：预设类别之外的自造物品名（如“水彩笔”）也允许接在上一条失物请求后
  const prior = [...history]
    .reverse()
    .find(
      (entry) =>
        entry.role === "user" && classifyCampus(entry.text) !== "unknown"
    );
  const shortNounReply = /^[\u4e00-\u9fffA-Za-z0-9]{2,12}$/.test(text.trim());
  if (
    prior &&
    ((classifyCampus(prior.text) === "lost" &&
      (categories.some((item) => text.includes(item)) || shortNounReply)) ||
      (classifyCampus(prior.text) === "repair" &&
        (/\d+\s*号楼/.test(text) ||
          repairItems.some((item) => text.includes(item)))))
  ) {
    return { kind: classifyCampus(prior.text), query: `${prior.text} ${text}` };
  }
  if (
    /^(那|那么|这个|它|还有|需要|什么时候|几点|为什么|如何|怎么|在哪里|哪些|材料|费用)/.test(
      text.trim()
    )
  ) {
    const previous = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.role === "user" && classifyCampus(entry.text) !== "unknown"
      );
    if (previous) {
      return {
        kind: classifyCampus(previous.text),
        query: `${previous.text} ${text}`,
      };
    }
  }
  return { kind, query: text };
}

function result(
  kind: CampusKind,
  tool: string,
  answer: string,
  found = false,
  sourceList: string[] = [],
  evidence = ""
): CampusOutcome {
  return {
    answer,
    evidence,
    found,
    kind,
    kindLabel: labels[kind],
    sources: sourceList,
    tool,
  };
}

// 论坛查询：优先用 LLM 做语义匹配，模型不可用或失败时回退到关键词匹配；命中后返回帖子入口
async function handleForumSearch(
  query: string,
  report?: ReportStep
): Promise<CampusOutcome> {
  report?.({ id: "execute", label: "正在查询校园论坛", state: "running" });
  const candidates = (await listForumPosts()).filter(
    (post) => post.lostItemStatus !== "closed"
  );
  if (candidates.length === 0) {
    report?.({ id: "execute", label: "论坛暂时没有帖子", state: "waiting" });
    return result("forum", "searchForum", "论坛目前还没有帖子。", false, [
      sources.searchForum!,
    ]);
  }

  let matches: ForumPost[] = [];
  let llmOk = false;
  if (hasModelProvider()) {
    report?.({
      id: "match",
      label: "正在用 AI 匹配相关帖子",
      state: "running",
    });
    try {
      matches = await matchForumPostsWithLLM(query, candidates);
      llmOk = true;
      report?.({
        id: "match",
        label:
          matches.length > 0
            ? `AI 匹配到 ${matches.length} 条相关帖子`
            : "AI 没有找到相关帖子",
        state: matches.length > 0 ? "done" : "waiting",
      });
    } catch {
      report?.({
        id: "match",
        label: "AI 匹配不可用，改用关键词匹配",
        state: "waiting",
      });
    }
  }
  if (matches.length === 0 && !llmOk) {
    matches = await searchForumPosts(query);
  }
  if (matches.length === 0) {
    report?.({ id: "execute", label: "没有找到相关帖子", state: "waiting" });
    return result(
      "forum",
      "searchForum",
      "没有找到相关帖子，可以换个说法描述要找的内容，或到论坛按分类和关键词查找。",
      false,
      [sources.searchForum!]
    );
  }

  report?.({
    id: "execute",
    label: `找到 ${matches.length} 条相关帖子`,
    state: "done",
  });
  const lines = matches.map(
    (post) =>
      `【${post.category}】${post.title}，${post.author}${post.eventTime ? `，${post.eventTime}` : ""}${post.place ? `，${post.place}` : ""}\n${post.body}`
  );
  const evidence = lines.join("\n\n");
  const answer = `${evidence}\n\n点击下方链接进入对应帖子。\n来源：${sources.searchForum}`;
  return {
    ...result(
      "forum",
      "searchForum",
      answer,
      true,
      [sources.searchForum!],
      evidence
    ),
    forumPostId: matches[0].id,
    forumPostLabel: "查看匹配的帖子",
    forumPosts: matches.map((post) => ({ id: post.id, title: post.title })),
  };
}

async function executeTool(
  userId: string,
  name: ToolName,
  args: Record<string, unknown>,
  confirmed = false,
  author = "同学"
): Promise<any> {
  if (toolPolicy[name] === "write" && !confirmed) {
    throw new Error("写操作尚未确认");
  }
  const selected = campusTools(userId, author)[name] as {
    inputSchema: { parse: (input: unknown) => unknown };
    execute?: (input: any, options: any) => unknown;
  };
  const parsed = selected.inputSchema.parse(args);
  if (!selected.execute) {
    throw new Error("工具不可执行");
  }
  return selected.execute(parsed, {
    abortSignal: undefined,
    messages: [],
    toolCallId: crypto.randomUUID(),
  });
}

async function ensureTables() {
  const db = await createDatabase();
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS "CampusPending" ("id" uuid PRIMARY KEY, "chatId" uuid NOT NULL, "userId" uuid NOT NULL, "plan" text NOT NULL, "status" text NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "CampusPending_one_pending" ON "CampusPending" ("chatId", "userId") WHERE "status" = 'pending'`
  );
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS "CampusTrace" ("id" uuid PRIMARY KEY, "chatId" uuid NOT NULL, "userId" uuid NOT NULL, "kind" text NOT NULL, "tool" text NOT NULL, "found" boolean NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`
  );
  await db.execute(
    sql`ALTER TABLE "CampusTrace" ADD COLUMN IF NOT EXISTS "sources" text NOT NULL DEFAULT '[]'`
  );
  return db;
}

export async function logCampusTrace(
  chatId: string,
  userId: string,
  outcome: CampusOutcome
) {
  const db = await ensureTables();
  await db.execute(
    sql`INSERT INTO "CampusTrace" ("id", "chatId", "userId", "kind", "tool", "found", "sources") VALUES (${crypto.randomUUID()}, ${chatId}, ${userId}, ${outcome.kind}, ${outcome.tool}, ${outcome.found}, ${JSON.stringify(outcome.sources)})`
  );
}

async function savePlan(chatId: string, userId: string, plan: Plan) {
  const db = await ensureTables();
  await db.execute(
    sql`UPDATE "CampusPending" SET "status" = 'superseded' WHERE "chatId" = ${chatId} AND "userId" = ${userId} AND "status" = 'pending'`
  );
  await db.execute(
    sql`INSERT INTO "CampusPending" ("id", "chatId", "userId", "plan", "status") VALUES (${crypto.randomUUID()}, ${chatId}, ${userId}, ${JSON.stringify(plan)}, 'pending')`
  );
}

async function resolvePlan(
  chatId: string,
  userId: string,
  approve: boolean,
  author: string,
  report?: ReportStep
): Promise<CampusOutcome> {
  report?.({ id: "confirm", label: "正在核对待确认操作", state: "running" });
  const db = await ensureTables();
  // A single atomic update prevents two confirmations from executing the same plan.
  const rows = (await db.execute(
    sql`UPDATE "CampusPending" SET "status" = ${approve ? "executing" : "cancelled"} WHERE "id" = (SELECT "id" FROM "CampusPending" WHERE "chatId" = ${chatId} AND "userId" = ${userId} AND "status" = 'pending' AND "createdAt" > now() - interval '30 minutes' ORDER BY "createdAt" DESC LIMIT 1) AND "status" = 'pending' RETURNING "id", "plan"`
  )) as unknown as { rows: { id: string; plan: string }[] };
  const pending = rows.rows[0];
  if (!pending) {
    report?.({ id: "confirm", label: "没有待确认的操作", state: "waiting" });
    return result("unknown", "", "当前没有待确认的操作。", false);
  }
  const plan = JSON.parse(pending.plan) as Plan;
  const kind: CampusKind =
    plan.tool === "createRepair"
      ? "repair"
      : plan.tool === "publishForum"
        ? "forum"
        : "lost";
  if (!approve) {
    report?.({ id: "confirm", label: "已取消，未执行操作", state: "done" });
    return result(kind, plan.tool, "已取消，未执行操作。", false);
  }
  report?.({ id: "confirm", label: "已核对用户确认", state: "done" });
  const action =
    plan.tool === "publishForum"
      ? "发布论坛帖子"
      : plan.tool === "registerLost"
        ? "登记失物信息"
        : plan.tool === "closeLost"
          ? "关闭失物记录"
          : "登记样本报修";
  report?.({ id: "execute", label: `正在${action}`, state: "running" });
  try {
    const output = await executeTool(
      userId,
      plan.tool,
      plan.args,
      true,
      author
    );
    await db.execute(
      sql`UPDATE "CampusPending" SET "status" = 'done' WHERE "id" = ${pending.id}`
    );
    if (plan.tool === "closeLost" && !output.closed) {
      report?.({
        id: "execute",
        label: "记录已关闭或不存在",
        state: "waiting",
      });
      return result(
        kind,
        plan.tool,
        "该记录已关闭或不存在，没有执行关闭。",
        false,
        [sources[plan.tool]!]
      );
    }
    report?.({ id: "execute", label: `${action}完成`, state: "done" });
    const evidence = JSON.stringify(output);
    const matchText =
      plan.tool === "registerLost" && output.matches.length
        ? `\n找到 ${output.matches.length} 条同类别的${output.item.kind === "lost" ? "招领" : "寻物"}记录，可能相关：${output.matches.map((item: { title: string; id: string }) => `${item.title}（${item.id.slice(0, 8)}）`).join("、")}。请进一步核对，系统不能确认是否为同一物品。${output.matchPost ? `下方链接对应编号 ${output.matchPostItemId.slice(0, 8)} 的帖子。` : "这些记录暂未关联论坛帖子，可稍后查询。"}`
        : "";
    const answer =
      plan.tool === "registerLost"
        ? `已登记${output.item.kind === "lost" ? "寻物" : "招领"}：${output.item.title}，编号 ${output.item.id.slice(0, 8)}。${matchText}\n${output.item.kind === "found" ? "谢谢你主动登记。交接前请核实认领人的物品特征，也可以联系学校核实过的失物招领渠道。" : "请通过学校核实过的失物招领渠道寻找，认领前注意核对物品特征。"}\n如需公开求助，可说“发布这条失物到论坛”；请勿公开证件号码、学号或联系方式。`
        : plan.tool === "closeLost"
          ? `已根据你的确认关闭「${output.item.title}」，编号 ${output.item.id.slice(0, 8)}。关联的论坛帖子会显示已解决。感谢你及时更新，让其他同学不再重复寻找。`
          : plan.tool === "publishForum"
            ? `已发布到校园论坛：${output.post.title}。\n${output.post.lostItemId ? "可在帖子详情查看并刷新站内联系消息。物品找回或归还后，告诉我“已经找回”或“已归还”，确认后可同步更新帖子状态。" : "请保护个人信息；需要交接时，可通过学校核实过的渠道联系并核对物品特征。"}`
            : `已登记本机样本报修：${output.place}，${output.item}，工单 ${output.ticketId}。不会提交到学校报修系统。`;
    return {
      ...result(
        kind,
        plan.tool,
        `${answer}\n来源：${sources[plan.tool]}`,
        true,
        [sources[plan.tool]!],
        evidence
      ),
      ...(plan.tool === "publishForum"
        ? { forumPostId: output.post.id }
        : plan.tool === "registerLost" && output.matchPost
          ? { forumPostId: output.matchPost.id, forumPostLabel: "查看相关帖子" }
          : {}),
    };
  } catch (error) {
    report?.({ id: "execute", label: `${action}未能完成`, state: "error" });
    await db.execute(
      sql`UPDATE "CampusPending" SET "status" = 'failed' WHERE "id" = ${pending.id}`
    );
    throw error;
  }
}

function asksToPublish(text: string, history: HistoryItem[]): boolean {
  if (/^(?:寻物启事|招领启事|失物招领)\s*[:：]/.test(text)) {
    return true;
  }
  if (
    /(?:发布|发).{0,8}(?:这条|该条|我的).{0,8}(?:失物|寻物|招领)/.test(text)
  ) {
    return true;
  }
  if (
    /(?:发布|发表|发|贴).{0,16}(?:论坛|帖子|贴子|帖|寻物|招领)|(?:论坛|帖子|贴子).{0,12}(?:发布|发表|发|贴)/.test(
      text
    )
  ) {
    return true;
  }
  if (
    /(?:帮我|替我|请|麻烦)?\s*(?:发布|发出去|发一下|发一条)[。！!\s]*$/.test(
      text
    )
  ) {
    return (
      /(失物|寻物|招领|丢了|捡到|论坛|帖子)/.test(text) ||
      history.some(
        (entry) =>
          entry.role === "user" &&
          /(失物|寻物|招领|丢了|捡到|论坛|帖子)/.test(entry.text)
      )
    );
  }
  return false;
}

function forumBody(text: string): string {
  return text
    .replace(/^(?:寻物启事|招领启事|失物招领)\s*[:：]\s*/g, "")
    .replace(
      /(?:请|麻烦|我想|我要|我需要)?(?:帮我|替我|给我)?(?:发布|发表|发)(?:到|在|去)(?:校园)?论坛/g,
      ""
    )
    .replace(
      /(?:请|麻烦|我想|我要|我需要)?(?:帮我|替我|给我)?(?:在|到|往)?(?:校园)?论坛(?:上|里|中)?(?:发一个帖子|发一条帖子|发个帖子|发帖子|发个帖|发帖|发表|发布|发一条|发)?/g,
      ""
    )
    .replace(
      /(?:请|麻烦|我想|我要|我需要)?(?:帮我|替我|给我)?(?:发布|发表|发)(?:一个|一条|一则|个)?(?:帖子|贴子|帖)/g,
      ""
    )
    .replace(
      /(?:请|麻烦|我想|我要|我需要)?(?:帮我|替我|给我)?(?:发布|发)(?:一个|一条|一则|个|这条|该条|我的)?(?:失物|寻物|招领)(?:启事|信息|帖子|帖)?/g,
      ""
    )
    .replace(
      /(?:请|麻烦)?(?:帮我|替我)?(?:发布|发出去|发一下|发一条)[。！!\s]*$/g,
      ""
    )
    .replace(/^[\s，。,:：、！!]+|[\s，。,:：、！!]+$/g, "")
    .trim();
}

function forumCategory(
  text: string
): "活动" | "讲座" | "社团" | "招领" | "求助" | "闲置" {
  if (/(捡到|拾到|招领)/.test(text)) {
    return "招领";
  }
  if (/(丢了|丢失|遗失|寻物|求助|不见了)/.test(text)) {
    return "求助";
  }
  if (/讲座/.test(text)) {
    return "讲座";
  }
  if (/(社团|招新)/.test(text)) {
    return "社团";
  }
  if (/(闲置|转让|出售)/.test(text)) {
    return "闲置";
  }
  return /活动/.test(text) ? "活动" : "求助";
}

// 未命中预设类别时，从原话兜底提取物品名：依次去掉联系方式、联络关键词、
// 动词短语与口语填充、量词、预设类别与地点、颜色词，取剩余的名词片段
function extractItemCategory(text: string): string | undefined {
  const cleaned = text
    .replace(
      /1[3-9]\d{9}|\d{17}[\dXx]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      " "
    )
    .replace(
      /(电话号码?|手机号码?|手机号?|联系方式|微信号?|QQ号?)\s*[是为:：]?/g,
      " "
    )
    .replace(
      /我(?:丢了|丢失了|遗失了|掉了|不见了|捡到了?|拾到了?)?|丢了|丢失|遗失|掉了|不见了|捡到|拾到|帮我|麻烦|请问|登记|找回|寻找|我的|东西|一支|一只|一个|一把|一条|一张|一部|一本|一台|一块/g,
      " "
    )
    .replace(
      new RegExp(`(?:${[...categories, ...places].join("|")})`, "g"),
      " "
    )
    .replace(/(?:黑|白|红|蓝|绿|灰|粉|棕|紫|黄|橙)色?/g, " ")
    .trim();
  return cleaned
    .split(/[\s，。,:：、！!?？.·]+/)
    .map((item) => item.trim())
    .find(
      (item) => item.length >= 2 && item.length <= 24 && !/^[0-9]+$/.test(item)
    );
}

export async function runCampusEngine(input: {
  text: string;
  history: HistoryItem[];
  userId: string;
  chatId: string;
  author?: string;
  report?: ReportStep;
}): Promise<CampusOutcome> {
  const { text, history, userId, chatId } = input;
  // 确认/取消指令允许首尾夹带引号和标点（如 确认发布”），避免用户复制预览文字时指令失效
  const command = text
    .trim()
    .replace(/^[\s"'“”‘’「」]+|[\s"'“”‘’「」。！!，,]+$/g, "");
  if (/^(确认|确认执行|确认登记|确认关闭|确认发布|是的确认)$/.test(command)) {
    return resolvePlan(
      chatId,
      userId,
      true,
      input.author ?? "同学",
      input.report
    );
  }
  if (/^(取消|取消操作|取消发布|不登记|不关闭|不发布)$/.test(command)) {
    return resolvePlan(
      chatId,
      userId,
      false,
      input.author ?? "同学",
      input.report
    );
  }
  input.report?.({ id: "classify", label: "正在识别请求", state: "running" });
  const db = await ensureTables();
  await db.execute(
    sql`UPDATE "CampusPending" SET "status" = 'superseded' WHERE "chatId" = ${chatId} AND "userId" = ${userId} AND "status" = 'pending'`
  );
  const awaitingPostContent =
    history.at(-1)?.role === "assistant" &&
    history.at(-1)?.text.includes("请告诉我要发布的帖子内容");
  if (asksToPublish(text, history) || awaitingPostContent) {
    input.report?.({
      id: "classify",
      label: "已识别为论坛发帖请求",
      state: "done",
    });
    let body = awaitingPostContent ? text.trim() : forumBody(text);
    const ownItems = await listOwnOpenItems(userId);
    const explicitId = ownItems.find((item) =>
      text.includes(item.id.slice(0, 8))
    );
    const recentRegistration = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.role === "assistant" && /已登记(?:寻物|招领)/.test(entry.text)
      );
    const recentId =
      recentRegistration?.text.match(/编号\s*([0-9a-f]{8})/i)?.[1];
    const refersToRecent =
      body.length < 2 || /(?:这条|该条|刚才|上面|发到论坛)/.test(text);
    const linked =
      explicitId ??
      (refersToRecent && recentId
        ? ownItems.find((item) => item.id.startsWith(recentId))
        : undefined);
    if (linked) {
      const existingPost = await getOpenForumPostForLostItem(linked.id);
      if (existingPost) {
        input.report?.({
          id: "draft",
          label: "该失物记录已有论坛帖子",
          state: "done",
        });
        return {
          ...result(
            "forum",
            "searchForum",
            "这条失物记录已经发布过，点击下方链接可以查看帖子和站内联系消息。",
            true,
            [sources.searchForum!]
          ),
          forumPostId: existingPost.id,
          forumPostLabel: "查看已有帖子",
        };
      }
    }
    if (
      linked &&
      (body.length < 2 ||
        /^(?:这条|该条|刚才|上面|失物|寻物|招领)+$/.test(body))
    ) {
      body = linked.detail;
    }
    if (body.length < 2) {
      const prior = [...history]
        .reverse()
        .find(
          (entry) =>
            entry.role === "user" &&
            !/^(确认|取消)/.test(entry.text) &&
            !asksToPublish(entry.text, []) &&
            /(丢|遗失|捡|拾|寻物|招领|活动|讲座|社团|闲置|求助)/.test(
              entry.text
            )
        );
      body = prior?.text.trim() ?? "";
    }
    if (body.length < 2) {
      input.report?.({
        id: "draft",
        label: "需要补充帖子内容",
        state: "waiting",
      });
      return result(
        "forum",
        "publishForum",
        "请告诉我要发布的帖子内容，例如物品、地点和联系方式。不要提供不希望公开的个人信息。"
      );
    }
    if (body.length > 2000) {
      return result(
        "forum",
        "publishForum",
        "帖子内容不能超过 2000 字，请缩短后重新发送。"
      );
    }
    // 未关联失物记录时，优先用 LLM 把一句话整理成结构化帖子（标题/正文/分类/地点/时间），模型不可用或失败时回退到规则提取；
    // 已关联失物记录时跳过模型改写，直接用登记信息确定性生成，避免模型遗漏物品名或把内容改写成空话
    let draft: Awaited<ReturnType<typeof draftForumPostWithLLM>> = null;
    if (!linked && hasModelProvider()) {
      input.report?.({
        id: "draft",
        label: "正在用 AI 整理帖子内容",
        state: "running",
      });
      try {
        draft = await draftForumPostWithLLM(body, null);
        input.report?.({
          id: "draft",
          label: draft ? "AI 已整理出帖子结构" : "AI 整理失败，按原文提取",
          state: draft ? "done" : "waiting",
        });
      } catch {
        input.report?.({
          id: "draft",
          label: "AI 整理不可用，按原文提取",
          state: "waiting",
        });
      }
    }
    // 已关联失物记录时，分类与记录类型强制一致（招领记录→招领、寻物记录→求助），
    // 不采信模型草稿的分类判断，避免招领帖被发到“求助”栏导致论坛分类页看不到
    const category = linked
      ? linked.kind === "found"
        ? "招领"
        : "求助"
      : (draft?.category ?? forumCategory(body));
    const isLostPost =
      Boolean(linked) ||
      draft?.lostKind != null ||
      category === "招领" ||
      (category === "求助" && /(失物|寻物|丢|遗失|捡到|拾到)/.test(body));
    if (draft) {
      body = draft.body;
    }
    // 关联失物记录时标题用记录类型 + 物品名确定性生成
    let title = linked
      ? `${linked.kind === "found" ? "招领启事" : "寻物启事"}：${linked.title}`
      : (draft?.title ?? "");
    // 招领/寻物帖沿用隐私保护：正文、标题、地点、时间统一脱敏后再预览与发布
    let redacted = false;
    let place = linked ? (linked.place ?? undefined) : draft?.place;
    let eventTime = draft?.eventTime ?? undefined;
    if (isLostPost) {
      const cleanBody = redactPublicText(body);
      const cleanTitle = redactPublicText(title);
      const cleanPlace = place ? redactPublicText(place) : place;
      const cleanEventTime = eventTime
        ? redactPublicText(eventTime)
        : eventTime;
      redacted =
        cleanBody !== body ||
        cleanTitle !== title ||
        cleanPlace !== place ||
        cleanEventTime !== eventTime;
      body = cleanBody;
      title = cleanTitle;
      place = cleanPlace;
      eventTime = cleanEventTime;
    }
    if (linked) {
      // 帖子正文带上登记编号，方便与失物招领库中的记录对应
      body = `${body}\n（${linked.kind === "found" ? "招领" : "寻物"}记录编号 ${linked.id.slice(0, 8)}，可通过站内联系核对物品特征）`;
    }
    if (title.length < 2) {
      title = body
        .split(/[。！？\n]/)[0]
        .slice(0, 80)
        .trim();
    }
    if (title.length < 2) {
      return result(
        "forum",
        "publishForum",
        "请补充至少两个字的帖子标题或内容。"
      );
    }
    const plan: Plan = {
      args: {
        body,
        category,
        title,
        ...(place ? { place } : {}),
        ...(eventTime ? { eventTime } : {}),
        ...(linked ? { lostItemId: linked.id } : {}),
      },
      description: "发布校园论坛帖子",
      tool: "publishForum",
    };
    await savePlan(chatId, userId, plan);
    input.report?.({
      id: "draft",
      label: "已生成帖子预览，等待确认",
      state: "waiting",
    });
    return {
      ...result(
        "forum",
        plan.tool,
        `请确认发布到校园论坛：\n发布者：${isLostPost ? "校园同学" : (input.author ?? "同学")}\n分类：${category}\n标题：${title}\n${place ? `地点：${place}\n` : ""}${eventTime ? `时间：${eventTime}\n` : ""}内容：${body}\n${linked ? `关联记录：${linked.id.slice(0, 8)}\n` : isLostPost ? "该帖未关联失物记录，不能使用站内联系和同步关闭；如需这些功能，请取消并先登记失物。\n" : ""}${redacted ? "已隐藏检测到的部分个人信息，请继续检查。\n" : ""}\n以上内容对论坛用户可见。请检查并删除不愿公开的信息；自动识别不一定完整。回复“确认发布”执行，回复“取消”放弃。`
      ),
      pending: true,
    };
  }
  const route = routeCampus(text, history);
  const kind = route.kind;
  input.report?.({
    id: "classify",
    label:
      kind === "unknown" ? "未识别为校园服务请求" : `已识别为${labels[kind]}`,
    state: "done",
  });
  const query = route.query;
  let plan: Plan | undefined;
  if (
    kind === "lost" &&
    /(已经找回|找回了|找到了|已找回|寻回|已寻回|已归还|已经归还|归还了|已送还|已领|领走了|关闭)/.test(text)
  ) {
    const allOwn = await listOwnOpenItems(userId);
    const own = /归还|送还/.test(text)
      ? allOwn.filter((item) => item.kind === "found")
      : /找回|找到了/.test(text)
        ? allOwn.filter((item) => item.kind === "lost")
        : allOwn;
    const mentioned = own.filter(
      (item) =>
        text.includes(item.id.slice(0, 8)) ||
        (item.category && text.includes(item.category))
    );
    const item =
      mentioned.length === 1
        ? mentioned[0]
        : mentioned.length === 0 && own.length === 1
          ? own[0]
          : undefined;
    if (!item) {
      return result(
        kind,
        "closeLost",
        own.length
          ? "你有多条待处理记录，请提供编号前八位以选择要关闭的一条。"
          : "没有找到你名下符合条件的开放记录。"
      );
    }
    plan = {
      args: { itemId: item.id },
      description: `关闭${item.kind === "found" ? "招领" : "寻物"}「${item.title}」（编号 ${item.id.slice(0, 8)}），关联帖子会显示已解决`,
      tool: "closeLost",
    };
  } else if (
    kind === "lost" &&
    /(捡到|拾到|丢了|丢失|不见了|掉了|遗失)/.test(query)
  ) {
    // 预设类别未命中时兜底提取物品名（如“水彩笔”），提取失败才要求用户补充
    const category =
      categories.find((value) => query.includes(value)) ??
      extractItemCategory(query);
    if (!category) {
      return result(kind, "registerLost", "请补充物品类别，例如雨伞或校园卡。");
    }
    const color = query.match(/(黑|白|红|蓝|绿|灰|粉|棕|紫|黄|橙)色?/)?.[1];
    const place = places.find((value) => query.includes(value));
    const lostKind = /(捡到|拾到)/.test(query) ? "found" : "lost";
    const title = `${color ? `${color}色` : ""}${category}`;
    plan = {
      args: {
        category,
        color: color ? `${color}色` : undefined,
        detail: redactPublicText(query),
        kind: lostKind,
        place,
        title,
      },
      description: `登记${lostKind === "lost" ? "寻物" : "招领"}「${title}」${place ? `，地点 ${place}` : ""}。公开内容会隐藏部分常见个人信息，但请自行检查`,
      tool: "registerLost",
    };
  } else if (kind === "repair" && !/(进度|怎么样了|查一下|工单)/.test(text)) {
    const place = query.match(/\d+\s*号楼\s*\d+(?:室|房间)?/)?.[0];
    const item = repairItems.find((value) => query.includes(value));
    if (!place || !item) {
      return result(
        kind,
        "createRepair",
        "报修需要楼栋房间和损坏项目，例如“6号楼312灯坏了”。"
      );
    }
    plan = {
      args: { detail: query, item, place },
      description: `登记本机样本报修：${place}，${item}（不会提交到学校系统）`,
      tool: "createRepair",
    };
  }
  if (plan) {
    await savePlan(chatId, userId, plan);
    input.report?.({
      id: "draft",
      label: "已准备操作，等待确认",
      state: "waiting",
    });
    return {
      ...result(
        kind,
        plan.tool,
        `请确认：${plan.description}。\n回复“确认”执行，回复“取消”放弃。`,
        false
      ),
      pending: true,
    };
  }
  // 未匹配到校园服务但内容含联系方式等敏感信息时，给出隐私提示并引导走登记流程；
  // suppressModel 阻止通用模型接管回答，避免联系方式在闲聊里明文流转或被复述
  if (
    kind === "unknown" &&
    /(1[3-9]\d{9}|\d{17}[\dXx]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|电话号码?|手机号码?|手机号|联系方式|微信号?|QQ号?)/.test(
      text
    )
  ) {
    input.report?.({
      id: "execute",
      label: "检测到联系方式，已提示隐私保护",
      state: "waiting",
    });
    return {
      ...result(
        "unknown",
        "",
        "注意到你发送的内容里可能包含电话号码等联系方式。为保护隐私，请不要在对话中直接发送证件号码或联系方式。如需登记寻物或招领，直接说“我在某地丢了某物”即可，我会先与你确认；确认后公开内容会自动隐藏常见个人信息。"
      ),
      suppressModel: true,
    };
  }
  if (kind === "forum") {
    return handleForumSearch(query, input.report);
  }
  const readTools: Partial<Record<CampusKind, ToolName>> = {
    access: "queryAccess",
    card: "campusCard",
    forum: "searchForum",
    lost: "searchLost",
    notice: "searchNotice",
    qa: "searchCampus",
    repair: "searchRepair",
  };
  const tool = readTools[kind];
  if (!tool) {
    return result(
      "unknown",
      "",
      "我还不能确定你的校园问题属于哪一类。可以补充具体地点、事项或物品。",
      false
    );
  }
  const args =
    tool === "campusCard"
      ? {
          action: /(余额|还剩多少钱|卡里)/.test(query)
            ? "balance"
            : /(补卡|补办|换卡)/.test(query)
              ? "replace"
              : "loss",
        }
      : { query };
  input.report?.({
    id: "execute",
    label: `正在查询${labels[kind]}`,
    state: "running",
  });
  let output: any;
  try {
    output = await executeTool(userId, tool, args);
  } catch (error) {
    input.report?.({
      id: "execute",
      label: `${labels[kind]}查询失败`,
      state: "error",
    });
    throw error;
  }
  const found =
    output.found ??
    (Array.isArray(output.items) ? output.items.length > 0 : true);
  input.report?.({
    id: "execute",
    label: found
      ? `${labels[kind]}查询完成`
      : `没有找到匹配的${labels[kind]}信息`,
    state: found ? "done" : "waiting",
  });
  if (!found) {
    return result(
      kind,
      tool,
      "当前资料没有找到匹配结果，请换个关键词或补充地点。",
      false,
      sources[tool] ? [sources[tool]!] : []
    );
  }
  let sourceList: string[] = sources[tool] ? [sources[tool]!] : [];
  let lines: string[] = [];
  if (tool === "searchNotice") {
    lines = output.notices.map(
      (x: any) => `${x.title}（${x.publishedAt}）\n${x.body}`
    );
    sourceList = output.notices.map((x: any) => x.source);
  } else if (tool === "searchCampus") {
    lines = output.articles.map((x: any) => x.body);
    sourceList = output.articles.map((x: any) => x.source);
  } else if (tool === "searchForum") {
    lines = output.posts.map(
      (x: any) =>
        `【${x.category}】${x.title}，${x.author}${x.eventTime ? `，${x.eventTime}` : ""}${x.place ? `，${x.place}` : ""}\n${x.body}`
    );
  } else if (tool === "searchLost") {
    lines = output.items.map(
      (x: any) =>
        `${x.kind === "found" ? "招领" : "寻物"}：${x.title}，编号 ${x.id.slice(0, 8)}\n${x.detail}`
    );
  } else if (tool === "searchRepair") {
    lines = output.tickets.map(
      (x: any) =>
        `${x.ticketId} ${x.place} ${x.item}，状态 ${x.status}，更新于 ${x.updatedAt}`
    );
  } else if (tool === "queryAccess") {
    lines = [`${output.place}开放时间：${output.openHours}`];
    sourceList = [output.source];
  } else {
    lines = [
      output.action === "balance"
        ? `余额 ${output.balance}，截至 ${output.asOf}。${output.note}`
        : output.action === "replace"
          ? `补办窗口：${output.window}。材料：${output.materials}。${output.note}`
          : `样本信息：校园卡${output.cardStatus}，自${output.since}。${output.note}这不代表已为你操作真实校园卡。`,
    ];
    sourceList = [output.source];
  }
  const evidence = lines.join("\n\n");
  const uniqueSources = [...new Set(sourceList)];
  return result(
    kind,
    tool,
    `${evidence}\n\n来源：${uniqueSources.join("；")}`,
    true,
    uniqueSources,
    evidence
  );
}
