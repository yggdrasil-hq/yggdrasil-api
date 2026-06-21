export type FeatureStatus =
  | "draft"
  | "spec_ready"
  | "queued"
  | "running"
  | "in_review"
  | "changes_requested"
  | "merged"
  | "failed"
  | "cancelled";

export type FeatureType = "normal" | "project_init";

export interface Feature {
  id: string;
  projectId: string;
  title: string;
  slug: string;
  featureType: FeatureType;
  status: FeatureStatus;
  adrMarkdown: string | null;
  awaitingUserInput: boolean;
  adrApproved: boolean;
  branchName: string | null;
  prUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicFeature {
  id: string;
  projectId: string;
  title: string;
  slug: string;
  featureType: FeatureType;
  specExcerpt: string;
  status: FeatureStatus;
  adrMarkdown: string | null;
  awaitingUserInput: boolean;
  adrApproved: boolean;
  branchName: string | null;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

function excerptFromAdr(adrMarkdown: string | null, title: string): string {
  if (!adrMarkdown?.trim()) {
    return "Spec in progress…";
  }

  const lines = adrMarkdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  return lines[0]?.slice(0, 240) ?? title;
}

export function toPublicFeature(feature: Feature): PublicFeature {
  return {
    id: feature.id,
    projectId: feature.projectId,
    title: feature.title,
    slug: feature.slug,
    featureType: feature.featureType,
    specExcerpt: excerptFromAdr(feature.adrMarkdown, feature.title),
    status: feature.status,
    adrMarkdown: feature.adrMarkdown,
    awaitingUserInput: feature.awaitingUserInput,
    adrApproved: feature.adrApproved,
    branchName: feature.branchName,
    prUrl: feature.prUrl,
    createdAt: feature.createdAt.toISOString(),
    updatedAt: feature.updatedAt.toISOString(),
  };
}
