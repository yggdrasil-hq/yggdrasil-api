import type { FeatureActionItemType } from "./types.js";

export interface FeatureActionItem {
  id: string;
  featureId: string;
  type: FeatureActionItemType;
  description: string;
  status: "open" | "resolved";
  resolvedAt: Date | null;
  secretKey: string | null;
  designSessionId: string | null;
  subtaskFeatureId: string | null;
  draftTestMarkdown: string | null;
  designSnapshot: Record<string, string> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicFeatureActionItem {
  id: string;
  type: FeatureActionItemType;
  description: string;
  status: "open" | "resolved";
  resolvedAt: string | null;
  secretKey: string | null;
  designSessionId: string | null;
  subtaskFeatureId: string | null;
  draftTestMarkdown: string | null;
  createdAt: string;
}

export function toPublicActionItem(item: FeatureActionItem): PublicFeatureActionItem {
  return {
    id: item.id,
    type: item.type,
    description: item.description,
    status: item.status,
    resolvedAt: item.resolvedAt?.toISOString() ?? null,
    secretKey: item.secretKey,
    designSessionId: item.designSessionId,
    subtaskFeatureId: item.subtaskFeatureId,
    draftTestMarkdown: item.draftTestMarkdown,
    createdAt: item.createdAt.toISOString(),
  };
}