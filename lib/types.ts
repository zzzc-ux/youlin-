import type { InferUITool, UIMessage } from "ai";
import { z } from "zod";
import type { ArtifactKind } from "@/components/chat/artifact";
import type { campusTools } from "./ai/tools/campus";
import type { createDocument } from "./ai/tools/create-document";
import type { requestSuggestions } from "./ai/tools/request-suggestions";
import type { imageTools } from "./ai/tools/search-images";
import type { newsTools } from "./ai/tools/search-news";
import type { weatherTools } from "./ai/tools/weather";
import type { updateDocument } from "./ai/tools/update-document";
import type { Suggestion } from "./db/schema";

export const messageMetadataSchema = z.object({
  createdAt: z.string(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

type campusToolSet = ReturnType<typeof campusTools>;
type createDocumentTool = InferUITool<ReturnType<typeof createDocument>>;
type updateDocumentTool = InferUITool<ReturnType<typeof updateDocument>>;
type requestSuggestionsTool = InferUITool<
  ReturnType<typeof requestSuggestions>
>;
type imageToolSet = ReturnType<typeof imageTools>;
type newsToolSet = ReturnType<typeof newsTools>;
type weatherToolSet = ReturnType<typeof weatherTools>;

export type ChatTools = {
  createDocument: createDocumentTool;
  updateDocument: updateDocumentTool;
  requestSuggestions: requestSuggestionsTool;
  searchCampus: InferUITool<campusToolSet["searchCampus"]>;
  searchForum: InferUITool<campusToolSet["searchForum"]>;
  publishForum: InferUITool<campusToolSet["publishForum"]>;
  registerLost: InferUITool<campusToolSet["registerLost"]>;
  searchLost: InferUITool<campusToolSet["searchLost"]>;
  closeLost: InferUITool<campusToolSet["closeLost"]>;
  searchNotice: InferUITool<campusToolSet["searchNotice"]>;
  createRepair: InferUITool<campusToolSet["createRepair"]>;
  searchRepair: InferUITool<campusToolSet["searchRepair"]>;
  campusCard: InferUITool<campusToolSet["campusCard"]>;
  queryAccess: InferUITool<campusToolSet["queryAccess"]>;
  searchImages: InferUITool<imageToolSet["searchImages"]>;
  grabImage: InferUITool<imageToolSet["grabImage"]>;
  searchNews: InferUITool<newsToolSet["searchNews"]>;
  getWeather: InferUITool<weatherToolSet["getWeather"]>;
};

export type CampusTraceData = {
  kindLabel: string;
  tool: string;
  sources: string[];
  found: boolean;
  steps?: CampusTraceStep[];
};

export type CampusTraceStep = {
  id: string;
  label: string;
  state: "running" | "done" | "waiting" | "error";
};

export type WaitingStatusData = {
  phase: "waiting" | "still-waiting" | "health" | "thinking";
  message: string;
  modelId: string;
  modelName: string;
};

export type CustomUIDataTypes = {
  textDelta: string;
  imageDelta: string;
  sheetDelta: string;
  codeDelta: string;
  suggestion: Suggestion;
  appendMessage: string;
  id: string;
  title: string;
  kind: ArtifactKind;
  clear: null;
  finish: null;
  "chat-title": string;
  "waiting-status": WaitingStatusData;
  "campus-trace": CampusTraceData;
  "forum-post-link": { postId: string; label?: string };
};

export type ChatMessage = UIMessage<
  MessageMetadata,
  CustomUIDataTypes,
  ChatTools
>;

export type Attachment = {
  name: string;
  url: string;
  contentType: string;
};
