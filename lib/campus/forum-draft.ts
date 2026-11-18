import { generateText } from "ai";
import { getLanguageModel, hasModelProvider } from "@/lib/ai/providers";
import { forumCategories } from "./forum-shared";

export type ForumDraft = {
  title: string;
  body: string;
  category: (typeof forumCategories)[number];
  place: string | null;
  eventTime: string | null;
  // lost=寻物启事，found=招领启事，null=普通帖子
  lostKind: "lost" | "found" | null;
};

const MAX_TITLE = 80;
const MAX_BODY = 2000;

// 从模型输出中提取 JSON 对象，兼容输出夹带解释文字的情况
function parseDraft(raw: string): ForumDraft | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    const category = typeof parsed.category === "string" ? parsed.category.trim() : "";
    if (title.length < 2 || title.length > MAX_TITLE) return null;
    if (body.length < 2 || body.length > MAX_BODY) return null;
    if (!(forumCategories as readonly string[]).includes(category)) return null;
    // 拦截模型在信息不足时的追问式占位输出（如“请补充帖子内容”），回退到原文提取
    if (/请补充|请提供|补充后|信息不足|内容缺失|未提供|无法确定|待定/.test(title + body)) return null;
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null);
    return {
      title,
      body,
      category: category as ForumDraft["category"],
      place: text(parsed.place),
      eventTime: text(parsed.eventTime),
      lostKind: parsed.lostKind === "lost" || parsed.lostKind === "found" ? parsed.lostKind : null,
    };
  } catch {
    return null;
  }
}

/**
 * 用 LLM 把用户的一句话整理成结构化论坛帖子（标题/正文/分类/地点/时间），
 * 精准识别寻物启事与招领启事。没有可用模型或输出无法解析时返回 null，由调用方回退到规则提取。
 */
export async function draftForumPostWithLLM(
  text: string,
  lostKind?: "lost" | "found" | null
): Promise<ForumDraft | null> {
  if (!hasModelProvider() || text.trim().length < 2) return null;

  // 已关联失物记录时把招领/寻物类型作为上下文告诉模型，避免模型把招领帖误判为求助
  const kindHint =
    lostKind === "found"
      ? "- 已知这是招领启事（用户捡到了东西）：category 必须用“招领”，lostKind 必须用 \"found\"，标题以“招领启事：”开头并点明物品\n"
      : lostKind === "lost"
        ? "- 已知这是寻物启事（用户丢了东西）：category 必须用“求助”，lostKind 必须用 \"lost\"，标题以“寻物启事：”开头并点明物品\n"
        : "";

  const { text: raw } = await generateText({
    model: getLanguageModel("forum-draft") as Parameters<typeof generateText>[0]["model"],
    prompt: `你是校园论坛的发帖助手。用户想用一句话在论坛发帖，请把用户的话整理成一条结构清晰、可以直接发布的帖子。
只输出一个 JSON 对象，不要输出任何解释或其他文字，格式：
{"title":"...","body":"...","category":"...","place":null,"eventTime":null,"lostKind":null}

要求：
${kindHint}- category 只能是：${forumCategories.join("、")}
- 用户丢了东西或要发寻物启事：category 用"求助"，lostKind 用 "lost"，标题以"寻物启事："开头并点明物品，例如"寻物启事：黑色书包"
- 用户捡到东西或要发招领启事：category 用"招领"，lostKind 用 "found"，标题以"招领启事："开头并点明物品
- 其他帖子 lostKind 为 null，标题概括主题，不超过 30 字
- body 用第一人称通顺复述用户说的事实信息，去掉"帮我发帖""发到论坛"等指令性语句；保留物品特征、地点、时间等细节；不要编造用户没说的信息（尤其是联系方式）
- 即使你觉得用户的话信息不够，也必须基于已有信息写出一条完整可发布的帖子；绝对不要输出“请补充”“请提供”“内容缺失”“待补充”之类的占位或追问文字，也不要反问
- place：事发或活动地点，用户没提则为 null；eventTime：事发或活动时间，用户没提则为 null
- title 2~80 字，body 2~2000 字

用户的话：${text}`,
  });

  return parseDraft(raw);
}
