import { ipAddress } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  streamText,
  toUIMessageStream,
} from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import { generateTitleFromUserMessage } from "@/lib/ai/generate-title";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import {
  DEEPSEEK_MODEL,
  getLanguageModel,
  hasModelProvider,
} from "@/lib/ai/providers";
import { createDocument } from "@/lib/ai/tools/create-document";
import { editDocument } from "@/lib/ai/tools/edit-document";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { imageTools } from "@/lib/ai/tools/search-images";
import { newsTools } from "@/lib/ai/tools/search-news";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { weatherTools } from "@/lib/ai/tools/weather";
import { PRODUCT_NAME } from "@/lib/brand";
import { logCampusTrace, runCampusEngine } from "@/lib/campus/engine";
import { redactPublicText } from "@/lib/campus/privacy";
import { isTestEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import { getRagConfig } from "@/lib/rag/config";
import { searchRag } from "@/lib/rag/search";
import { checkIpRateLimit } from "@/lib/ratelimit";
import type {
  CampusTraceData,
  CampusTraceStep,
  ChatMessage,
  WaitingStatusData,
} from "@/lib/types";
import {
  convertToUIMessages,
  generateUUID,
  getTextFromMessage,
} from "@/lib/utils";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

// 通用回答路径的隐私兜底：把对话历史里用户与助手消息的文本统一脱敏，
// 避免电话号码、证件号等联系方式明文进入模型上下文并被复述或写进建议文案
type ModelMessageLike = { content: unknown };

function redactModelMessageTexts<T extends ModelMessageLike>(
  messages: T[]
): T[] {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return { ...message, content: redactPublicText(message.content) };
    }
    if (Array.isArray(message.content)) {
      const parts = message.content.map((part: unknown) => {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return {
            ...(part as object),
            text: redactPublicText((part as { text: string }).text),
          };
        }
        return part;
      });
      return { ...message, content: parts as typeof message.content };
    }
    return message;
  });
}

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch {
    return null;
  }
}

export { getStreamContext };

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch {
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const { id, message, messages, selectedChatModel, selectedVisibilityType } =
      requestBody;

    const [botIdResult, session] = await Promise.all([
      checkBotId().catch(() => null),
      auth(),
    ]);

    if (botIdResult?.isBot) {
      return new ChatbotError("forbidden:api").toResponse();
    }

    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    const chatModel = hasModelProvider() ? DEEPSEEK_MODEL : DEFAULT_CHAT_MODEL;
    void selectedChatModel;

    await checkIpRateLimit(ipAddress(request));

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      differenceInHours: 1,
      id: session.user.id,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerHour) {
      return new ChatbotError("rate_limit:chat").toResponse();
    }

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      messagesFromDb = await getMessagesByChatId({ id });
    } else if (message?.role === "user") {
      await saveChat({
        id,
        title: "新的对话",
        userId: session.user.id,
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

    let uiMessages: ChatMessage[];

    if (isToolApprovalFlow && messages) {
      const dbMessages = convertToUIMessages(messagesFromDb);
      const approvalStates = new Map(
        messages.flatMap(
          (m) =>
            m.parts
              ?.filter(
                (p: Record<string, unknown>) =>
                  p.state === "approval-responded" ||
                  p.state === "output-denied"
              )
              .map((p: Record<string, unknown>) => [
                String(p.toolCallId ?? ""),
                p,
              ]) ?? []
        )
      );
      uiMessages = dbMessages.map((msg) => ({
        ...msg,
        parts: msg.parts.map((part) => {
          if (
            "toolCallId" in part &&
            approvalStates.has(String(part.toolCallId))
          ) {
            return { ...part, ...approvalStates.get(String(part.toolCallId)) };
          }
          return part;
        }),
      })) as ChatMessage[];
    } else {
      uiMessages = [
        ...convertToUIMessages(messagesFromDb),
        message as ChatMessage,
      ];
    }

    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            attachments: [],
            chatId: id,
            createdAt: new Date(),
            id: message.id,
            parts: message.parts,
            role: "user",
          },
        ],
      });
    }

    const modelMessages = await convertToModelMessages(uiMessages);

    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        const modelName = chatModel;
        // 必须最先写入 start：AI SDK 客户端在收到 start 之前会为 data 部件新建一条消息，
        // 若先写 data-campus-trace，会导致同一条回答在界面上多出一张“影子”处理过程卡片。
        dataStream.write({ type: "start" });
        const writeWaitingStatus = (
          phase: WaitingStatusData["phase"],
          messageText: string
        ) => {
          dataStream.write({
            data: {
              message: messageText,
              modelId: chatModel,
              modelName,
              phase,
            },
            transient: true,
            type: "data-waiting-status",
          });
        };

        const userText = message ? getTextFromMessage(message) : "";
        if (!userText) {
          if (!isToolApprovalFlow) {
            throw new Error("缺少用户消息");
          }
          const continuation = streamText({
            messages: modelMessages,
            model: getLanguageModel(chatModel) as Parameters<
              typeof streamText
            >[0]["model"],
            system:
              "处理用户对文档工具的确认。不要声称执行了未调用的校园操作。",
            tools: {
              createDocument: createDocument({
                dataStream,
                modelId: chatModel,
                session,
              }),
              editDocument: editDocument({ dataStream, session }),
              requestSuggestions: requestSuggestions({
                dataStream,
                modelId: chatModel,
                session,
              }),
              updateDocument: updateDocument({
                dataStream,
                modelId: chatModel,
                session,
              }),
            },
          });
          dataStream.merge(
            toUIMessageStream({
              sendReasoning: false,
              stream: continuation.stream,
            })
          );
          return;
        }
        writeWaitingStatus("waiting", "正在理解你的问题…");
        const history = uiMessages
          .slice(0, -1)
          .slice(-6)
          .map((item) => ({
            role: item.role,
            text: getTextFromMessage(item),
          }));
        const traceId = generateUUID();
        let trace: CampusTraceData = {
          found: false,
          kindLabel: "处理中",
          sources: [],
          steps: [],
          tool: "",
        };
        const publishTrace = () =>
          dataStream.write({
            data: { ...trace, steps: [...(trace.steps ?? [])] },
            id: traceId,
            type: "data-campus-trace",
          });
        const report = (step: CampusTraceStep) => {
          const steps = trace.steps ?? [];
          const index = steps.findIndex((item) => item.id === step.id);
          trace = {
            ...trace,
            steps:
              index < 0
                ? [...steps, step]
                : steps.map((item) => (item.id === step.id ? step : item)),
          };
          publishTrace();
        };
        let outcome: Awaited<ReturnType<typeof runCampusEngine>>;
        try {
          outcome = await runCampusEngine({
            author: session.user.email ?? "同学",
            chatId: id,
            history,
            report,
            text: userText,
            userId: session.user.id,
          });
        } catch (error) {
          const running = trace.steps?.find((step) => step.state === "running");
          if (running) {
            report({ ...running, label: "处理未能完成", state: "error" });
          }
          console.error("Campus request failed", { chatId: id, error });
          await logCampusTrace(id, session.user.id, {
            answer: "",
            evidence: "",
            found: false,
            kind: "unknown",
            kindLabel: "处理失败",
            sources: [],
            tool: "",
          }).catch(() => undefined);
          throw error;
        }
        await logCampusTrace(id, session.user.id, outcome).catch((error) =>
          console.error("Campus trace logging failed", error)
        );
        trace = {
          ...trace,
          found: outcome.found,
          kindLabel: outcome.kindLabel,
          sources: outcome.sources,
          tool: outcome.tool,
        };
        if (
          !outcome.found &&
          outcome.tool &&
          !(trace.steps ?? []).some(
            (step) => step.id === "draft" || step.id === "execute"
          )
        ) {
          report({
            id: "result",
            label: "需要进一步确认或补充信息",
            state: "waiting",
          });
        } else {
          publishTrace();
        }
        writeWaitingStatus("thinking", "正在整理回答…");
        // 校园问答（qa）也走模型合成：检索结果作为上下文，由模型组织成自然回答
        const isKnowledgeAnswer =
          outcome.kind === "qa" && Boolean(outcome.evidence);
        const canUseModel =
          (outcome.kind === "unknown" || isKnowledgeAnswer) &&
          !outcome.suppressModel &&
          !/^(确认|取消)/.test(userText) &&
          hasModelProvider() &&
          !isTestEnvironment;
        if (canUseModel) {
          report({
            id: "model",
            label: isKnowledgeAnswer
              ? "正在基于知识库生成回答"
              : "正在生成一般问题的回答",
            state: "running",
          });
          let ragContext = "";
          if (isKnowledgeAnswer) {
            // qa 已在引擎里完成检索，直接用其证据作为上下文
            ragContext = outcome.evidence;
            report({
              id: "rag",
              label: `知识库命中 ${outcome.sources.length} 条内容`,
              state: "done",
            });
          } else {
            // RAG：先检索本地知识库，把候选内容交给模型判断相关性
            try {
              const rag = await searchRag(userText, 3);
              const minScore = getRagConfig().minScore;
              const goodHits = rag.hits.filter((hit) => hit.score >= minScore);
              if (goodHits.length > 0) {
                report({
                  id: "rag",
                  label: `知识库检索完成，参考 ${goodHits.length} 条内容`,
                  state: "done",
                });
                ragContext = goodHits
                  .map(
                    (hit) =>
                      `【来源：${hit.doc} · 相似度 ${hit.score.toFixed(2)}】\n${hit.snippet}`
                  )
                  .join("\n\n");
              } else {
                report({
                  id: "rag",
                  label: "知识库未命中相关内容",
                  state: "done",
                });
              }
            } catch {
              report({
                id: "rag",
                label: "知识库检索不可用，已跳过",
                state: "error",
              });
            }
          }
          const systemPrompt = isKnowledgeAnswer
            ? `你的名字是${PRODUCT_NAME}。请依据下面的知识库检索结果，用自然、简洁的中文回答用户问题：可以适当归纳分点，但不要编造知识库里没有的信息；不要照抄"Q:""A:"的原始问答格式；回答末尾用（来源：文档名）标注来源。不要声称执行了任何操作。对话中用户发过的电话号码、证件号、邮箱等联系方式已被隐藏，这是刻意的隐私保护：不要猜测、复述或编造用户的联系方式。\n\n===== 知识库检索结果 =====\n${ragContext}\n===== 知识库检索结果结束 =====`
            : ragContext
              ? `你的名字是${PRODUCT_NAME}。本系统支持校园失物招领登记与论坛发帖：用户说“我在某地丢了/捡到了某物”即可登记，确认后可发布到校园论坛，公开内容会自动隐藏常见个人信息，因此不要声称系统没有失物招领功能或没有发布权限。下面是本地知识库的检索结果，请自行判断它们与用户问题是否相关：相关时优先依据知识库内容回答并在回答末尾标注来源文档名；不相关时完全忽略知识库内容，正常回答一般问题。不要声称执行了任何操作。对话中用户发过的电话号码、证件号、邮箱等联系方式已被隐藏，这是刻意的隐私保护：不要猜测、复述或编造用户的联系方式，写参考文案时用“通过失物招领渠道或站内联系”之类的表述代替具体号码。\n\n===== 知识库检索结果 =====\n${ragContext}\n===== 知识库检索结果结束 =====`
              : `你的名字是${PRODUCT_NAME}。本系统支持校园失物招领登记与论坛发帖：用户说“我在某地丢了/捡到了某物”即可登记，确认后可发布到校园论坛，公开内容会自动隐藏常见个人信息，因此不要声称系统没有失物招领功能或没有发布权限。对闲聊或一般问题自然回答；没有资料时不要声称知道校园实时事实，也不要声称执行了任何操作。对话中用户发过的电话号码、证件号、邮箱等联系方式已被隐藏，这是刻意的隐私保护：不要猜测、复述或编造用户的联系方式，写参考文案时用“通过失物招领渠道或站内联系”之类的表述代替具体号码。用户要找图片、找配图时调用 searchImages，用户挑中某一张后再调用 grabImage 保存到本站，不要一次保存多张。用户问最近有什么新闻、某个话题的报道时调用 searchNews，引用时注明来源媒体，不要把外部新闻说成校园官方信息。用户问天气、气温、下不下雨时调用 getWeather，location 填城市名，并提示数据来自外部气象服务。`;
          const general = streamText({
            messages: redactModelMessageTexts(modelMessages),
            model: getLanguageModel(chatModel) as Parameters<
              typeof streamText
            >[0]["model"],
            onError: () =>
              report({ id: "model", label: "回答生成失败", state: "error" }),
            onFinish: () => {
              if (
                trace.steps?.find((step) => step.id === "model")?.state !==
                "error"
              ) {
                report({
                  id: "model",
                  label: isKnowledgeAnswer
                    ? "基于知识库的回答已生成"
                    : "一般问题的回答已生成",
                  state: "done",
                });
              }
            },
            system: systemPrompt,
            tools: {
              ...imageTools(),
              ...newsTools(),
              ...weatherTools(),
              createDocument: createDocument({
                dataStream,
                modelId: chatModel,
                session,
              }),
              editDocument: editDocument({ dataStream, session }),
              requestSuggestions: requestSuggestions({
                dataStream,
                modelId: chatModel,
                session,
              }),
              updateDocument: updateDocument({
                dataStream,
                modelId: chatModel,
                session,
              }),
            },
          });
          dataStream.merge(
            toUIMessageStream({ sendReasoning: false, stream: general.stream })
          );
        } else {
          const textId = "campus-text";
          dataStream.write({ type: "start" });
          dataStream.write({ type: "start-step" });
          dataStream.write({ id: textId, type: "text-start" });
          dataStream.write({
            delta: outcome.answer,
            id: textId,
            type: "text-delta",
          });
          dataStream.write({ id: textId, type: "text-end" });
          if (outcome.forumPostId) {
            dataStream.write({
              data: {
                label: outcome.forumPostLabel,
                postId: outcome.forumPostId,
              },
              type: "data-forum-post-link",
            });
          }
          for (const post of outcome.forumPosts ?? []) {
            if (post.id === outcome.forumPostId) {
              continue;
            }
            dataStream.write({
              data: {
                label: `查看帖子：${post.title.slice(0, 24)}`,
                postId: post.id,
              },
              type: "data-forum-post-link",
            });
          }
          dataStream.write({ type: "finish-step" });
          dataStream.write({ finishReason: "stop", type: "finish" });
        }
        if (titlePromise) {
          try {
            const title = await titlePromise;
            dataStream.write({ data: title, type: "data-chat-title" });
            await updateChatTitleById({ chatId: id, title });
          } catch {
            /* 标题生成失败不影响回答 */
          }
        }
      },
      generateId: generateUUID,
      onEnd: async ({ messages: finishedMessages }) => {
        if (isToolApprovalFlow) {
          await Promise.all(
            finishedMessages.map(async (finishedMsg) => {
              const existingMsg = uiMessages.find(
                (m) => m.id === finishedMsg.id
              );
              if (existingMsg) {
                await updateMessage({
                  id: finishedMsg.id,
                  parts: finishedMsg.parts,
                });
                return;
              }

              await saveMessages({
                messages: [
                  {
                    attachments: [],
                    chatId: id,
                    createdAt: new Date(),
                    id: finishedMsg.id,
                    parts: finishedMsg.parts,
                    role: finishedMsg.role,
                  },
                ],
              });
            })
          );
        } else if (finishedMessages.length > 0) {
          await saveMessages({
            messages: finishedMessages.map((currentMessage) => ({
              attachments: [],
              chatId: id,
              createdAt: new Date(),
              id: currentMessage.id,
              parts: currentMessage.parts,
              role: currentMessage.role,
            })),
          });
        }
      },
      onError: (error) => {
        if (
          error instanceof Error &&
          error.message?.includes(
            "AI Gateway requires a valid credit card on file to service requests"
          )
        ) {
          return "模型服务暂不可用，请联系管理员检查模型配置。";
        }
        return "出了点问题，请稍后再试。";
      },
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
    });

    return createUIMessageStreamResponse({
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ chatId: id, streamId });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch {
          /* non-critical */
        }
      },
      stream,
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    if (
      error instanceof Error &&
      error.message?.includes(
        "AI Gateway requires a valid credit card on file to service requests"
      )
    ) {
      return new ChatbotError("bad_request:activate_gateway").toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatbotError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
