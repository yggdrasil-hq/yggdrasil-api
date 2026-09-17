import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_KINDS,
  isKindEnabled,
  isKnownNotificationKind,
  shouldNotify,
  type NotificationPreference,
} from "./preferences.js";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

function pref(
  kind: string | null,
  enabled: boolean,
): Pick<NotificationPreference, "kind" | "enabled"> {
  return { kind, enabled };
}

describe("shouldNotify (ADR 027)", () => {
  /**
   * The regression guard. Every notification path predates preferences, so a
   * user with no rows must behave exactly as before: notify.
   */
  it("notifies when the user has no preference rows and no mute", () => {
    expect(
      shouldNotify({
        kind: "feature_created",
        projectId: PROJECT_ID,
        projectMuted: false,
        preferences: [],
      }),
    ).toBe(true);
  });

  it("suppresses a kind the user explicitly disabled", () => {
    expect(
      shouldNotify({
        kind: "feature_created",
        projectId: PROJECT_ID,
        projectMuted: false,
        preferences: [pref("feature_created", false)],
      }),
    ).toBe(false);
  });

  it("keeps a kind the user explicitly enabled even inside a disabled org", () => {
    expect(
      shouldNotify({
        kind: "adr_approved",
        projectId: PROJECT_ID,
        projectMuted: false,
        preferences: [pref(null, false), pref("adr_approved", true)],
      }),
    ).toBe(true);
  });

  it("falls back to the org-wide row for a kind with no row of its own", () => {
    expect(
      shouldNotify({
        kind: "build_started",
        projectId: PROJECT_ID,
        projectMuted: false,
        preferences: [pref(null, false)],
      }),
    ).toBe(false);
    expect(
      shouldNotify({
        kind: "build_started",
        projectId: PROJECT_ID,
        projectMuted: false,
        preferences: [pref(null, true)],
      }),
    ).toBe(true);
  });

  it("lets a per-project mute win over an enabled kind and an enabled org", () => {
    expect(
      shouldNotify({
        kind: "feature_created",
        projectId: PROJECT_ID,
        projectMuted: true,
        preferences: [pref(null, true), pref("feature_created", true)],
      }),
    ).toBe(false);
  });

  /** A mute is keyed by project, so a notification naming none cannot match one. */
  it("leaves a project-less notification to its org/kind row", () => {
    expect(
      shouldNotify({
        kind: "feature_created",
        projectId: null,
        projectMuted: true,
        preferences: [],
      }),
    ).toBe(true);
    expect(
      shouldNotify({
        kind: "feature_created",
        projectId: null,
        projectMuted: true,
        preferences: [pref(null, false)],
      }),
    ).toBe(false);
  });
});

describe("isKindEnabled", () => {
  it("mirrors the write-path precedence so UI and API agree", () => {
    const preferences = [pref(null, false), pref("adr_approved", true)];
    expect(isKindEnabled("adr_approved", preferences)).toBe(true);
    expect(isKindEnabled("feature_created", preferences)).toBe(false);
    expect(isKindEnabled("feature_created", [])).toBe(true);
  });
});

describe("NOTIFICATION_KINDS registry", () => {
  it("covers exactly the kinds the API creates, with labels and descriptions", async () => {
    const { NOTIFICATION_KIND_LABELS, NOTIFICATION_KIND_DESCRIPTIONS } = await import(
      "./preferences.js"
    );
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KIND_LABELS[kind]).toBeTruthy();
      expect(NOTIFICATION_KIND_DESCRIPTIONS[kind]).toBeTruthy();
    }
    expect(NOTIFICATION_KINDS).toHaveLength(5);
  });

  it("rejects job kinds that never create a notification", () => {
    for (const jobKind of ["spec_grill", "feature_build", "deploy", "design_grill"]) {
      expect(isKnownNotificationKind(jobKind)).toBe(false);
    }
    expect(isKnownNotificationKind("feature_created")).toBe(true);
  });
});
