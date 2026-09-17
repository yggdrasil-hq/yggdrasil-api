import type { DesignContinuationContext } from "./repository.js";

/**
 * Composes the brief a `design_grill` pod receives (ADR 020 item 5).
 *
 * A re-opened session has to know it is continuing an existing design rather
 * than starting from nothing, so it reads and iterates on the committed
 * `designs/<slug>/` folder instead of inventing a parallel one. The
 * design-grill prompt has exactly one free-text channel — the brief, which the
 * Orchestrator renders verbatim into `buildDesignGrillPrompt` — so that is
 * where this goes, framed the way ADR 015's `appendSpecContext` frames a
 * re-grill ("this is a continuation of an earlier run"). A structured
 * `specContext`-shaped channel would be the tidier home, but the design prompt
 * never reads one today; introducing that is an Orchestrator change (ADR 020's
 * follow-ups), not something this lane can wire.
 *
 * Pure by construction so the composition is unit-testable without a pod or a
 * database.
 */
export function composeDesignBrief(
  description: string,
  slug: string,
  continuation: DesignContinuationContext | null,
): string {
  if (!continuation) return description;

  const lines = [
    "---",
    `This is a continuation of an earlier design session for the same design folder, \`designs/${slug}/\`.`,
    "Reuse what already exists there, keep its established visual language, and change only what the brief below asks for. Do not start a parallel folder.",
  ];

  if (continuation.prUrl) {
    lines.push(
      `The previous session committed the design and opened a draft PR: ${continuation.prUrl}`,
    );
    lines.push(
      "If those files are not present in this workspace yet (the PR may not be merged), fetch the branch it names first.",
    );
  }

  if (continuation.paths.length > 0) {
    lines.push(`Files the previous session committed:\n${continuation.paths.map((path) => `- ${path}`).join("\n")}`);
  }

  return `${description}\n\n${lines.join("\n")}`;
}
