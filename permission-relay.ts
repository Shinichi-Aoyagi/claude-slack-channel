/**
 * Permission relay pure functions.
 *
 * Extracted from server.ts so they can be unit-tested without triggering
 * top-level side effects (process.exit, mcp.connect, slackApp.start).
 *
 * See .tmp/plan.md for the full design rationale.
 */

export interface PermissionRequestParams {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

export type PermissionVerdict = "allow" | "deny";
export type ReplyVia = "button" | "text";

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

/**
 * Parse a user's text reply into a verdict + requestId.
 * Returns null for anything that isn't a valid permission reply, so the caller
 * can fall through to normal chat routing.
 *
 * Normalizes before matching: strips backticks/smart-quotes Slack may inject
 * when copy-pasting, and replaces non-breaking spaces (U+00A0) with regular spaces.
 */
export function parsePermissionReply(
  text: string,
): { verdict: PermissionVerdict; requestId: string } | null {
  const normalized = text
    .replace(/[`\u2018\u2019\u201c\u201d]/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
  const m = PERMISSION_REPLY_RE.exec(normalized);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const requestId = m[2].toLowerCase();
  return {
    verdict: verb.startsWith("y") ? "allow" : "deny",
    requestId,
  };
}

/**
 * Decide whether the permission relay is currently enabled.
 * Both an approver set and a permission channel are required.
 */
export function computePermissionRelayEnabled(
  approvers: Set<string>,
  channel: string,
): { enabled: true } | { enabled: false; reason: string } {
  if (approvers.size === 0) {
    return { enabled: false, reason: "permissionApprovers is empty" };
  }
  if (!channel) {
    return { enabled: false, reason: "permissionChannel is not set" };
  }
  return { enabled: true };
}

/**
 * Decide whether an incoming message should be routed through the permission
 * reply pre-filter (i.e. checked for `yes/no <id>` before channelFilter/allowFrom).
 */
export function shouldRoutePermissionReply(input: {
  channel: string;
  permissionChannel: string;
  permissionRelayEnabled: boolean;
}): boolean {
  if (!input.permissionRelayEnabled) return false;
  return input.channel === input.permissionChannel;
}

/**
 * Classify what to do with a permission reply (shared by button and text paths).
 * The caller is responsible for extracting requestId/verdict beforehand and
 * checking pending.has(requestId).
 */
export function decidePermissionReplyAction(input: {
  userId: string;
  approvers: Set<string>;
  pendingHas: boolean;
}): { kind: "forbidden" | "stale" | "verdict" } {
  if (!input.approvers.has(input.userId)) return { kind: "forbidden" };
  if (!input.pendingHas) return { kind: "stale" };
  return { kind: "verdict" };
}

/**
 * Build the Block Kit payload for a new permission prompt.
 */
export function buildPermissionBlocks(
  req: PermissionRequestParams,
  approvers: string[],
): unknown[] {
  const approverMentions =
    approvers.length > 0
      ? approvers.map((u) => `<@${u}>`).join(", ")
      : "(allowlist empty)";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `🔔 *Claude が ${req.tool_name} の実行許可を求めています*\n` +
          `${req.description}\n` +
          "```" +
          req.input_preview +
          "```\n" +
          `Request ID: \`${req.request_id}\``,
      },
    },
    {
      type: "actions",
      block_id: `permission_${req.request_id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ 許可" },
          style: "primary",
          action_id: "permission_allow",
          value: req.request_id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ 拒否" },
          style: "danger",
          action_id: "permission_deny",
          value: req.request_id,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `承認可能: ${approverMentions} | ボタンクリックまたは yes ${req.request_id} / no ${req.request_id} をこのチャンネルで返信`,
        },
      ],
    },
  ];
}

/**
 * Build the Block Kit payload that replaces the permission prompt once a
 * verdict has been recorded. Buttons are dropped on purpose.
 */
export function buildVerdictUpdateBlocks(
  userId: string,
  verdict: PermissionVerdict,
  via: ReplyVia,
): unknown[] {
  const time = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  const emoji = verdict === "allow" ? "✅" : "❌";
  const verb = verdict === "allow" ? "許可" : "拒否";
  const viaLabel = via === "text" ? " (text reply)" : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} <@${userId}> が${verb}しました（${time}）${viaLabel}`,
      },
    },
  ];
}

/**
 * Block Kit payload for a stale permission (request_id not in pending map
 * at the time of click/reply).
 */
export function buildStaleUpdateBlocks(): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "⏰ このリクエストは期限切れか既に処理済みです",
      },
    },
  ];
}
