import { ipAddress } from "@vercel/functions";
import { generateText, type ModelMessage } from "ai";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import {
  DEEPSEEK_MODEL,
  getLanguageModel,
  hasModelProvider,
} from "@/lib/ai/providers";
import { PRODUCT_NAME } from "@/lib/brand";
import { isTestEnvironment } from "@/lib/constants";
import { checkIpRateLimit } from "@/lib/ratelimit";

export const maxDuration = 60;

// 桌宠「小邻」：有邻校园服务的页内吉祥物，回答保持短句、轻量。
// 与主聊天接口刻意分离：不进会话库、不计入聊天配额、不暴露任何工具。
const PET_NAME = "小邻";

const PET_SYSTEM_PROMPT = `你是${PET_NAME}，校园服务「${PRODUCT_NAME}」网页右下角的桌宠吉祥物，形象是一个活泼的看板娘。
回复要求：
- 一次只说一句话，不超过 40 个字，口语化、亲切自然，可以用一个 emoji 或颜文字。
- 你能聊日常、给一句鼓励、提醒同学去用站内功能（失物登记在对话里说、逛论坛、查天气等），但不要编造站内没有的功能。
- 校园实时信息（通知、余额、开放时间等）你并不掌握，被问到就坦诚说不知道，引导去站内查询。
- 不要声称你执行了任何操作（发帖、查询等），你只是个桌宠。
- 始终用简体中文。`;

const FALLBACK_REPLIES = [
  "我在哦～今天校园里有什么新鲜事吗？",
  "咦，找我有事吗？(◍•ᴗ•◍)",
  "丢东西的话，去对话里说「我捡到/丢了东西」就能登记啦！",
  "论坛最近挺热闹的，要不要去逛逛？",
  "天气好的话记得出门走走呀～",
  "我一直在右下角蹲着呢，随时叫我！",
];

const petRequestSchema = z.object({
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(300),
      })
    )
    .max(6)
    .default([]),
  message: z.string().min(1).max(200),
});

function pickFallbackReply(): string {
  return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)];
}

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return Response.json({ error: "请先登录" }, { status: 401 });
  }

  await checkIpRateLimit(ipAddress(request));

  let body: z.infer<typeof petRequestSchema>;

  try {
    const json = await request.json();
    body = petRequestSchema.parse(json);
  } catch {
    return Response.json({ error: "请求格式不正确" }, { status: 400 });
  }

  // 没有 DeepSeek 密钥（或测试环境）时退回本地萌系占位回复，桌宠不至于哑掉。
  if (!hasModelProvider() || isTestEnvironment) {
    return Response.json({ reply: pickFallbackReply(), source: "local" });
  }

  const messages: ModelMessage[] = [
    ...body.history.map((item) => ({
      content: item.text,
      role: item.role,
    })),
    { content: body.message, role: "user" },
  ];

  try {
    const result = await generateText({
      maxOutputTokens: 200,
      messages,
      model: getLanguageModel(DEEPSEEK_MODEL) as Parameters<
        typeof generateText
      >[0]["model"],
      system: PET_SYSTEM_PROMPT,
    });

    const reply = result.text.trim().slice(0, 160);

    return Response.json({
      reply: reply || pickFallbackReply(),
      source: "model",
    });
  } catch (error) {
    console.error("Pet chat failed", error);
    return Response.json(
      { reply: pickFallbackReply(), source: "local" },
      { status: 200 }
    );
  }
}
