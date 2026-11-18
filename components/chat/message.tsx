"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import Link from "next/link";
import { ArrowUpRight, LoaderCircleIcon } from "lucide-react";
import type { Vote } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { MessageContent, MessageResponse } from "../ai-elements/message";
import { Shimmer } from "../ai-elements/shimmer";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "../ai-elements/tool";
import { useDataStream } from "./data-stream-provider";
import { DocumentToolResult } from "./document";
import { DocumentPreview } from "./document-preview";
import { BrandMark } from "../effects/brand-mark";
import { CampusToolChip } from "./campus-tool-chip";
import { CampusTrace } from "./campus-trace";
import { GrabbedImageCard, ImageSearchGrid, type ImageSearchItem } from "./image-search-result";
import { NewsSearchList, type NewsSearchItem } from "./news-search-result";
import { WeatherCard, type WeatherCardData } from "./weather-result";
import { MessageActions } from "./message-actions";
import { MessageReasoning } from "./message-reasoning";
import { PreviewAttachment } from "./preview-attachment";

function WaitingText() {
  const { waitingStatus } = useDataStream();
  const waitingText = waitingStatus?.message ?? "正在思考…";

  return (
    <div className="flex min-h-[calc(14px*1.75)] min-w-0 items-center gap-2 text-[14px] leading-[1.75]">
      <span className="flex gap-1">
        <span className="thinking-dot size-1.5 rounded-full bg-violet-300" />
        <span className="thinking-dot size-1.5 rounded-full bg-fuchsia-300 [animation-delay:0.15s]" />
        <span className="thinking-dot size-1.5 rounded-full bg-cyan-300 [animation-delay:0.3s]" />
      </span>
      <Shimmer
        as="span"
        className="font-medium whitespace-normal break-words"
        duration={1}
      >
        {waitingText}
      </Shimmer>
    </div>
  );
}

function ToolRunning({ label }: { label: string }) {
  return (
    <div className="glass inline-flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-[13px]">
      <LoaderCircleIcon className="size-3.5 animate-spin text-violet-600 dark:text-violet-300" />
      <Shimmer as="span" className="font-medium" duration={1.2}>
        {`${label}…`}
      </Shimmer>
    </div>
  );
}

const PurePreviewMessage = ({
  addToolApprovalResponse: _addToolApprovalResponse,
  chatId,
  message,
  vote,
  isLoading,
  setMessages: _setMessages,
  regenerate: _regenerate,
  isReadonly,
  requiresScrollPadding: _requiresScrollPadding,
  onEdit,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  chatId: string;
  message: ChatMessage;
  vote: Vote | undefined;
  isLoading: boolean;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  requiresScrollPadding: boolean;
  onEdit?: (message: ChatMessage) => void;
}) => {
  const attachmentsFromMessage = message.parts.filter(
    (part) => part.type === "file"
  );

  useDataStream();

  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  const hasAnyContent = message.parts?.some(
    (part) =>
      (part.type === "text" && part.text?.trim().length > 0) ||
      (part.type === "reasoning" &&
        "text" in part &&
        part.text?.trim().length > 0) ||
      part.type === "data-campus-trace" ||
      part.type.startsWith("tool-")
  );
  const isThinking = isAssistant && isLoading && !hasAnyContent;

  const attachments = attachmentsFromMessage.length > 0 && (
    <div
      className="flex flex-row justify-end gap-2"
      data-testid={"message-attachments"}
    >
      {attachmentsFromMessage.map((attachment) => (
        <PreviewAttachment
          attachment={{
            contentType: attachment.mediaType,
            name: attachment.filename ?? "file",
            url: attachment.url,
          }}
          key={attachment.url}
        />
      ))}
    </div>
  );

  const mergedReasoning = message.parts?.reduce(
    (acc, part) => {
      if (part.type === "reasoning" && part.text?.trim().length > 0) {
        return {
          isStreaming: "state" in part ? part.state === "streaming" : false,
          rendered: false,
          text: acc.text ? `${acc.text}\n\n${part.text}` : part.text,
        };
      }
      return acc;
    },
    { isStreaming: false, rendered: false, text: "" }
  ) ?? { isStreaming: false, rendered: false, text: "" };

  // 流式过程中同一份处理过程可能被写入多次快照，只渲染最后一份，避免出现多张重复卡片
  const lastTracePartIndex = message.parts
    ? message.parts.reduce((last, part, index) => (part.type === "data-campus-trace" ? index : last), -1)
    : -1;

  const parts = message.parts?.map((part, index) => {
    const { type } = part;
    const key = `message-${message.id}-part-${index}`;

    if (type === "reasoning") {
      if (!mergedReasoning.rendered && mergedReasoning.text) {
        mergedReasoning.rendered = true;
        return (
          <MessageReasoning
            isLoading={isLoading || mergedReasoning.isStreaming}
            key={key}
            reasoning={mergedReasoning.text}
          />
        );
      }
      return null;
    }

    if (type === "data-campus-trace") {
      if (index !== lastTracePartIndex) return null;
      return <CampusTrace key={key} trace={part.data} />;
    }

    if (type === "data-forum-post-link") {
      return (
        <Link
          className="inline-flex w-fit items-center gap-1.5 rounded-lg text-sm font-medium text-violet-700 underline underline-offset-4 hover:text-violet-900 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-violet-600 dark:text-violet-300 dark:hover:text-violet-100"
          href={`/forum?post=${encodeURIComponent(part.data.postId)}`}
          key={key}
        >
          {part.data.label ?? "查看发布的帖子"} <ArrowUpRight aria-hidden="true" className="size-4" />
        </Link>
      );
    }

    if (type === "text") {
      return (
        <MessageContent
          className={cn("text-[14px] leading-[1.75]", {
            "bubble-user w-fit max-w-[min(80%,56ch)] overflow-hidden break-words rounded-2xl rounded-br-md px-4 py-2.5":
              message.role === "user",
          })}
          data-testid="message-content"
          key={key}
        >
          <MessageResponse>{sanitizeText(part.text)}</MessageResponse>
        </MessageContent>
      );
    }

    if (type === "tool-createDocument") {
      const { toolCallId } = part;

      if (part.output && "error" in part.output) {
        return (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
            key={toolCallId}
          >
            文档创建失败：{String(part.output.error)}
          </div>
        );
      }

      return (
        <DocumentPreview
          isReadonly={isReadonly}
          key={toolCallId}
          result={part.output}
        />
      );
    }

    if (type === "tool-updateDocument") {
      const { toolCallId } = part;

      if (part.output && "error" in part.output) {
        return (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
            key={toolCallId}
          >
            文档更新失败：{String(part.output.error)}
          </div>
        );
      }

      return (
        <div className="relative" key={toolCallId}>
          <DocumentPreview
            args={{ ...part.output, isUpdate: true }}
            isReadonly={isReadonly}
            result={part.output}
          />
        </div>
      );
    }

    if (
      type === "tool-searchCampus" ||
      type === "tool-searchForum" ||
      type === "tool-registerLost" ||
      type === "tool-searchLost" ||
      type === "tool-closeLost" ||
      type === "tool-searchNotice" ||
      type === "tool-createRepair" ||
      type === "tool-searchRepair" ||
      type === "tool-campusCard" ||
      type === "tool-queryAccess"
    ) {
      const { state, toolCallId } = part;
      return <CampusToolChip key={toolCallId} state={state} type={type} />;
    }

    if (type === "tool-requestSuggestions") {
      const { toolCallId, state } = part;

      return (
        <Tool
          className="w-[min(100%,450px)]"
          defaultOpen={true}
          key={toolCallId}
        >
          <ToolHeader state={state} type="tool-requestSuggestions" />
          <ToolContent>
            {state === "input-available" && <ToolInput input={part.input} />}
            {state === "output-available" && (
              <ToolOutput
                errorText={undefined}
                output={
                  "error" in part.output ? (
                    <div className="rounded border p-2 text-red-500">
                      出错：{String(part.output.error)}
                    </div>
                  ) : (
                    <DocumentToolResult
                      isReadonly={isReadonly}
                      result={part.output}
                      type="request-suggestions"
                    />
                  )
                }
              />
            )}
          </ToolContent>
        </Tool>
      );
    }

    if (type === "tool-searchImages") {
      const { toolCallId, state } = part;

      if (state === "output-available") {
        const output = part.output as {
          error?: string;
          images?: ImageSearchItem[];
          note?: string;
          query?: string;
        };

        if (output?.error) {
          return (
            <div
              className="glass w-fit rounded-xl px-3.5 py-2.5 text-[13px] text-red-600 dark:text-red-300"
              key={toolCallId}
            >
              {output.error}
            </div>
          );
        }

        return (
          <ImageSearchGrid
            images={output?.images ?? []}
            key={toolCallId}
            note={output?.note}
            query={output?.query ?? ""}
          />
        );
      }

      return <ToolRunning key={toolCallId} label="正在搜索图片" />;
    }

    if (type === "tool-grabImage") {
      const { toolCallId, state } = part;

      if (state === "output-available") {
        const output = part.output as {
          bytes?: number;
          error?: string;
          ok?: boolean;
          url?: string;
        };

        if (output?.ok && output.url) {
          return (
            <GrabbedImageCard
              bytes={output.bytes ?? 0}
              key={toolCallId}
              url={output.url}
            />
          );
        }

        return (
          <div
            className="glass w-fit rounded-xl px-3.5 py-2.5 text-[13px] text-red-600 dark:text-red-300"
            key={toolCallId}
          >
            保存图片失败：{output?.error ?? "未知错误"}
          </div>
        );
      }

      return <ToolRunning key={toolCallId} label="正在保存图片" />;
    }

    if (type === "tool-searchNews") {
      const { toolCallId, state } = part;

      if (state === "output-available") {
        const output = part.output as {
          error?: string;
          news?: NewsSearchItem[];
          note?: string;
          query?: string;
        };

        if (output?.error) {
          return (
            <div
              className="glass w-fit rounded-xl px-3.5 py-2.5 text-[13px] text-red-600 dark:text-red-300"
              key={toolCallId}
            >
              {output.error}
            </div>
          );
        }

        return (
          <NewsSearchList
            key={toolCallId}
            news={output?.news ?? []}
            note={output?.note}
            query={output?.query ?? ""}
          />
        );
      }

      return <ToolRunning key={toolCallId} label="正在搜索新闻" />;
    }

    if (type === "tool-getWeather") {
      const { toolCallId, state } = part;

      if (state === "output-available") {
        const output = part.output as {
          error?: string;
          found?: boolean;
          location?: string;
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
          forecast?: WeatherCardData["forecast"];
        };

        if (output?.error) {
          return (
            <div
              className="glass w-fit rounded-xl px-3.5 py-2.5 text-[13px] text-red-600 dark:text-red-300"
              key={toolCallId}
            >
              {output.error}
            </div>
          );
        }

        return (
          <WeatherCard
            key={toolCallId}
            weather={{
              area: output?.area,
              current: output?.current,
              forecast: output?.forecast,
              location: output?.location,
            }}
          />
        );
      }

      return <ToolRunning key={toolCallId} label="正在查询天气" />;
    }

    return null;
  });

  const actions = !isReadonly && (
    <MessageActions
      chatId={chatId}
      isLoading={isLoading}
      key={`action-${message.id}`}
      message={message}
      onEdit={onEdit ? () => onEdit(message) : undefined}
      vote={vote}
    />
  );

  const content = isThinking ? (
    <WaitingText />
  ) : (
    <>
      {attachments}
      {parts}
      {actions}
    </>
  );

  return (
    <div
      className={cn(
        "group/message w-full",
        !isAssistant && "animate-[fade-up_0.25s_cubic-bezier(0.22,1,0.36,1)]"
      )}
      data-role={message.role}
      data-testid={`message-${message.role}`}
    >
      <div
        className={cn(
          isUser ? "flex flex-col items-end gap-2" : "flex items-start gap-3"
        )}
      >
        {isAssistant && (
          <div className="flex h-[calc(14px*1.75)] shrink-0 items-center pt-0.5">
            <BrandMark active={isLoading} size={24} />
          </div>
        )}
        {isAssistant ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2">{content}</div>
        ) : (
          content
        )}
      </div>
    </div>
  );
};

export const PreviewMessage = PurePreviewMessage;

export const ThinkingMessage = () => (
  <div
    className="group/message w-full"
    data-role="assistant"
    data-testid="message-assistant-loading"
  >
    <div className="flex items-start gap-3">
      <div className="flex h-[calc(14px*1.75)] shrink-0 items-center pt-0.5">
        <BrandMark active size={24} />
      </div>

      <WaitingText />
    </div>
  </div>
);
