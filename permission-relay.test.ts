import { describe, it, expect } from "bun:test";
import {
  parsePermissionReply,
  buildPermissionBlocks,
  buildVerdictUpdateBlocks,
  computePermissionRelayEnabled,
  shouldRoutePermissionReply,
  decidePermissionReplyAction,
} from "./permission-relay";

describe("parsePermissionReply", () => {
  it("allows 'yes <id>'", () => {
    expect(parsePermissionReply("yes abcde")).toEqual({
      verdict: "allow",
      requestId: "abcde",
    });
  });

  it("allows 'y <id>' shorthand", () => {
    expect(parsePermissionReply("y abcde")).toEqual({
      verdict: "allow",
      requestId: "abcde",
    });
  });

  it("denies 'no <id>'", () => {
    expect(parsePermissionReply("no abcde")).toEqual({
      verdict: "deny",
      requestId: "abcde",
    });
  });

  it("denies 'n <id>' shorthand", () => {
    expect(parsePermissionReply("n abcde")).toEqual({
      verdict: "deny",
      requestId: "abcde",
    });
  });

  it("is case-insensitive and lowercases requestId (phone autocorrect)", () => {
    expect(parsePermissionReply("Yes Abcde")).toEqual({
      verdict: "allow",
      requestId: "abcde",
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parsePermissionReply("  yes abcde  ")).toEqual({
      verdict: "allow",
      requestId: "abcde",
    });
  });

  it("rejects unknown verbs", () => {
    expect(parsePermissionReply("approve abcde")).toBeNull();
  });

  it("rejects missing requestId", () => {
    expect(parsePermissionReply("yes")).toBeNull();
  });

  it("rejects requestId containing 'l' (not in [a-km-z])", () => {
    expect(parsePermissionReply("yes ablde")).toBeNull();
  });

  it("rejects requestId of wrong length", () => {
    expect(parsePermissionReply("yes abcd")).toBeNull();
    expect(parsePermissionReply("yes abcdef")).toBeNull();
  });

  it("rejects normal chat messages (regression)", () => {
    expect(parsePermissionReply("こんにちは")).toBeNull();
    expect(parsePermissionReply("yes but not a reply")).toBeNull();
  });

  it("rejects requestId with digits", () => {
    expect(parsePermissionReply("yes abcd1")).toBeNull();
  });
});

describe("computePermissionRelayEnabled", () => {
  it("disables when approvers empty", () => {
    expect(computePermissionRelayEnabled(new Set(), "C123")).toEqual({
      enabled: false,
      reason: "permissionApprovers is empty",
    });
  });

  it("disables when channel empty", () => {
    expect(
      computePermissionRelayEnabled(new Set(["U1"]), ""),
    ).toEqual({
      enabled: false,
      reason: "permissionChannel is not set",
    });
  });

  it("enables when both set", () => {
    expect(
      computePermissionRelayEnabled(new Set(["U1"]), "C123"),
    ).toEqual({ enabled: true });
  });

  it("prioritizes approvers-empty reason when both empty", () => {
    expect(computePermissionRelayEnabled(new Set(), "")).toEqual({
      enabled: false,
      reason: "permissionApprovers is empty",
    });
  });
});

describe("shouldRoutePermissionReply", () => {
  it("returns false when relay disabled", () => {
    expect(
      shouldRoutePermissionReply({
        channel: "C1",
        permissionChannel: "C1",
        permissionRelayEnabled: false,
      }),
    ).toBe(false);
  });

  it("returns true when enabled and channel matches", () => {
    expect(
      shouldRoutePermissionReply({
        channel: "C1",
        permissionChannel: "C1",
        permissionRelayEnabled: true,
      }),
    ).toBe(true);
  });

  it("returns false when enabled but channel differs", () => {
    expect(
      shouldRoutePermissionReply({
        channel: "C2",
        permissionChannel: "C1",
        permissionRelayEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("decidePermissionReplyAction", () => {
  const approvers = new Set(["U_APPROVER"]);

  it("returns forbidden for non-approver", () => {
    expect(
      decidePermissionReplyAction({
        userId: "U_OTHER",
        approvers,
        pendingHas: true,
      }),
    ).toEqual({ kind: "forbidden" });
  });

  it("returns stale when pending missing", () => {
    expect(
      decidePermissionReplyAction({
        userId: "U_APPROVER",
        approvers,
        pendingHas: false,
      }),
    ).toEqual({ kind: "stale" });
  });

  it("returns verdict when approver and pending exists", () => {
    expect(
      decidePermissionReplyAction({
        userId: "U_APPROVER",
        approvers,
        pendingHas: true,
      }),
    ).toEqual({ kind: "verdict" });
  });

  it("forbidden takes priority over stale", () => {
    expect(
      decidePermissionReplyAction({
        userId: "U_OTHER",
        approvers,
        pendingHas: false,
      }),
    ).toEqual({ kind: "forbidden" });
  });
});

describe("buildPermissionBlocks", () => {
  const req = {
    request_id: "abcde",
    tool_name: "Bash",
    description: "List files",
    input_preview: "ls -la",
  };

  it("contains section, actions, context blocks", () => {
    const blocks = buildPermissionBlocks(req, ["U1", "U2"]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("section");
    expect(blocks[1].type).toBe("actions");
    expect(blocks[2].type).toBe("context");
  });

  it("uses plain_text for button text (Slack spec)", () => {
    const blocks = buildPermissionBlocks(req, ["U1"]);
    const actions = blocks[1] as any;
    expect(actions.elements[0].text.type).toBe("plain_text");
    expect(actions.elements[1].text.type).toBe("plain_text");
  });

  it("sets action_id and value correctly", () => {
    const blocks = buildPermissionBlocks(req, ["U1"]);
    const actions = blocks[1] as any;
    expect(actions.elements[0].action_id).toBe("permission_allow");
    expect(actions.elements[0].value).toBe("abcde");
    expect(actions.elements[1].action_id).toBe("permission_deny");
    expect(actions.elements[1].value).toBe("abcde");
  });

  it("includes approver mentions in context", () => {
    const blocks = buildPermissionBlocks(req, ["U1", "U2"]);
    const ctx = blocks[2] as any;
    expect(ctx.elements[0].text).toContain("<@U1>");
    expect(ctx.elements[0].text).toContain("<@U2>");
  });

  it("includes request_id in section text", () => {
    const blocks = buildPermissionBlocks(req, ["U1"]);
    const section = blocks[0] as any;
    expect(section.text.text).toContain("abcde");
    expect(section.text.text).toContain("Bash");
  });

  it("uses block_id containing request_id", () => {
    const blocks = buildPermissionBlocks(req, ["U1"]);
    const actions = blocks[1] as any;
    expect(actions.block_id).toBe("permission_abcde");
  });
});

describe("buildVerdictUpdateBlocks", () => {
  it("emits allow + button via", () => {
    const blocks = buildVerdictUpdateBlocks("U1", "allow", "button");
    expect(blocks).toHaveLength(1);
    const section = blocks[0] as any;
    expect(section.text.text).toContain("✅");
    expect(section.text.text).toContain("<@U1>");
    expect(section.text.text).toContain("許可");
  });

  it("emits deny + button via", () => {
    const blocks = buildVerdictUpdateBlocks("U1", "deny", "button");
    const section = blocks[0] as any;
    expect(section.text.text).toContain("❌");
    expect(section.text.text).toContain("拒否");
  });

  it("distinguishes text reply via label", () => {
    const blocks = buildVerdictUpdateBlocks("U1", "allow", "text");
    const section = blocks[0] as any;
    expect(section.text.text).toContain("text reply");
  });

  it("does not include action buttons (buttons removed)", () => {
    const blocks = buildVerdictUpdateBlocks("U1", "allow", "button");
    expect(blocks.find((b: any) => b.type === "actions")).toBeUndefined();
  });
});
