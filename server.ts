#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { App, LogLevel } from "@slack/bolt";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { z } from "zod";
import {
  parsePermissionReply,
  computePermissionRelayEnabled,
  shouldRoutePermissionReply,
  decidePermissionReplyAction,
  buildPermissionBlocks,
  buildVerdictUpdateBlocks,
  buildStaleUpdateBlocks,
} from "./permission-relay";

// Load config (config.json provides defaults, env vars override)
const configPath = join(import.meta.dir, "config.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));

// Load .env if exists
const envPath = join(import.meta.dir, ".env");
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .env not found, rely on environment variables
}

// Tokens
const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;

if (!botToken || !appToken) {
  console.error(
    "[slack-channel] SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required. " +
    "Set them in .env or as environment variables."
  );
  process.exit(1);
}

// Channel filter and allowlist
const channelFilter: string[] = process.env.SLACK_CHANNELS
  ? process.env.SLACK_CHANNELS.split(",").map((c: string) => c.trim())
  : (config.channels ?? []);
const channelFilterSet = new Set(channelFilter);
const shouldFilterChannels = channelFilterSet.size > 0;

const allowFromList: string[] = process.env.SLACK_ALLOW_FROM
  ? process.env.SLACK_ALLOW_FROM.split(",").map((s: string) => s.trim())
  : (config.allowFrom ?? []);
const allowFrom = new Set(allowFromList);
const shouldGate = allowFrom.size > 0;

// Permission relay: separate allowlist + dedicated channel. Both required to enable.
const permissionApproversList: string[] = process.env.SLACK_PERMISSION_APPROVERS
  ? process.env.SLACK_PERMISSION_APPROVERS.split(",").map((s) => s.trim()).filter(Boolean)
  : (config.permissionApprovers ?? []);
const permissionApprovers = new Set(permissionApproversList);

const permissionChannel: string = (
  process.env.SLACK_PERMISSION_CHANNEL ?? config.permissionChannel ?? ""
).trim();

const permissionRelayState = computePermissionRelayEnabled(
  permissionApprovers,
  permissionChannel,
);
const permissionRelayEnabled = permissionRelayState.enabled;

// pending permission requests (request_id -> Slack message coordinates)
// Claimed atomically via get+delete before emitting verdicts (see plan §4).
const pendingPermissions = new Map<string, { channel: string; ts: string }>();

// Inbox directory for downloaded files
const inboxDir = join(import.meta.dir, "inbox");
mkdirSync(inboxDir, { recursive: true });

// stderr for debug logging (stdout is reserved for MCP stdio)
const log = (msg: string) => console.error(`[slack-channel] ${msg}`);

// Log permission relay status
if (permissionRelayEnabled) {
  log(
    `permission relay enabled (channel=${permissionChannel}, approvers=${permissionApprovers.size} users)`,
  );
} else {
  log(`permission relay disabled: ${(permissionRelayState as { reason: string }).reason}`);
}

// Create MCP server. capabilities.experimental['claude/channel/permission'] is
// only declared when sender gating is in place (docs: "Only declare the
// capability if your channel authenticates the sender").
const mcp = new Server(
  { name: "slack", version: "0.0.1" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        ...(permissionRelayEnabled ? { "claude/channel/permission": {} } : {}),
      },
      tools: {},
    },
    instructions: [
      'Messages from Slack arrive as <channel source="slack" chat_id="..." user="..." user_id="..." ts="...">.',
      "chat_id is the Slack channel ID.",
      "Reply with the reply tool, passing chat_id back.",
      "To reply in a thread, also pass thread_ts.",
      "Messages with file attachments include attachment_count and attachments attributes listing name/type/size.",
      "Use download_attachment to fetch files. Use upload_file to send files to Slack.",
    ].join(" "),
  }
);

// Tools
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message to a Slack channel",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description: "Slack channel ID to send to",
          },
          text: {
            type: "string",
            description: "The message text to send",
          },
          thread_ts: {
            type: "string",
            description: "Thread timestamp to reply in a thread (optional)",
          },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "download_attachment",
      description: "Download file attachments from a Slack message",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: {
            type: "string",
            description: "Slack file ID to download",
          },
        },
        required: ["file_id"],
      },
    },
    {
      name: "upload_file",
      description: "Upload a file to a Slack channel",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description: "Slack channel ID to upload to",
          },
          file_path: {
            type: "string",
            description: "Absolute path to the file to upload",
          },
          title: {
            type: "string",
            description: "Title for the uploaded file (optional)",
          },
          thread_ts: {
            type: "string",
            description: "Thread timestamp to upload in a thread (optional)",
          },
        },
        required: ["chat_id", "file_path"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { chat_id, text, thread_ts } = req.params.arguments as {
      chat_id: string;
      text: string;
      thread_ts?: string;
    };

    await slackApp.client.chat.postMessage({
      channel: chat_id,
      text,
      ...(thread_ts ? { thread_ts } : {}),
    });

    log(`Sent to ${chat_id}: ${text.substring(0, 80)}...`);
    return { content: [{ type: "text", text: "sent" }] };
  }

  if (req.params.name === "download_attachment") {
    const { file_id } = req.params.arguments as { file_id: string };

    // Get file info
    const fileInfo = await slackApp.client.files.info({ file: file_id });
    const file = fileInfo.file;
    if (!file || !file.url_private_download) {
      return { content: [{ type: "text", text: `File ${file_id} not found or not downloadable` }] };
    }

    // Download the file
    const response = await fetch(file.url_private_download, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!response.ok) {
      return { content: [{ type: "text", text: `Download failed: ${response.status}` }] };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const fileName = file.name ?? `${file_id}`;
    const savePath = join(inboxDir, `${Date.now()}-${fileName}`);
    writeFileSync(savePath, buffer);

    log(`Downloaded ${fileName} (${buffer.length} bytes) to ${savePath}`);
    return {
      content: [{
        type: "text",
        text: `Downloaded: ${savePath}\n  ${fileName} (${file.mimetype}, ${buffer.length} bytes)`,
      }],
    };
  }

  if (req.params.name === "upload_file") {
    const { chat_id, file_path, title, thread_ts } = req.params.arguments as {
      chat_id: string;
      file_path: string;
      title?: string;
      thread_ts?: string;
    };

    const fileContent = readFileSync(file_path);
    const fileName = basename(file_path);

    await slackApp.client.filesUploadV2({
      channel_id: chat_id,
      file: fileContent,
      filename: fileName,
      title: title ?? fileName,
      ...(thread_ts ? { thread_ts } : {}),
    });

    log(`Uploaded ${fileName} to ${chat_id}`);
    return { content: [{ type: "text", text: `Uploaded ${fileName} to ${chat_id}` }] };
  }

  throw new Error(`unknown tool: ${req.params.name}`);
});

// ========== Create Slack app (moved up so permission handlers can reference it) ==========
const slackApp = new App({
  token: botToken,
  appToken: appToken,
  socketMode: true,
  logLevel: LogLevel.ERROR,
  // Prevent Bolt from using console.log (conflicts with MCP stdio)
  logger: {
    debug: (...msgs) => console.error("[slack-bolt:debug]", ...msgs),
    info: (...msgs) => console.error("[slack-bolt:info]", ...msgs),
    warn: (...msgs) => console.error("[slack-bolt:warn]", ...msgs),
    error: (...msgs) => console.error("[slack-bolt:error]", ...msgs),
    setLevel: () => {},
    getLevel: () => LogLevel.ERROR,
    setName: () => {},
  },
});

// Get bot's own user ID to ignore self-messages
let botUserId: string | undefined;

// ========== Permission relay: MCP notification handler (registered before mcp.connect) ==========
if (permissionRelayEnabled) {
  const PermissionRequestSchema = z.object({
    method: z.literal("notifications/claude/channel/permission_request"),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  });

  mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    try {
      const blocks = buildPermissionBlocks(params, Array.from(permissionApprovers));
      const result = await slackApp.client.chat.postMessage({
        channel: permissionChannel,
        text: `Claude wants to run ${params.tool_name}: ${params.description}`,
        blocks: blocks as any,
      });
      if (result.ts) {
        pendingPermissions.set(params.request_id, {
          channel: permissionChannel,
          ts: result.ts as string,
        });
        log(
          `permission request posted (request_id=${params.request_id}, tool=${params.tool_name})`,
        );
      } else {
        log(`permission request post returned no ts for ${params.request_id}`);
      }
    } catch (e) {
      log(`permission request post failed: ${e}`);
    }
  });
}

// ========== Permission relay: Slack button action handlers ==========
if (permissionRelayEnabled) {
  for (const [actionId, verdict] of [
    ["permission_allow", "allow"],
    ["permission_deny", "deny"],
  ] as const) {
    slackApp.action(actionId, async ({ body, ack, respond, client }) => {
      await ack();
      const b = body as any;
      const userId: string | undefined = b.user?.id;
      const requestId: string = b.actions?.[0]?.value ?? "";
      const msgChannel: string | undefined = b.channel?.id;
      const msgTs: string | undefined = b.message?.ts;

      if (!userId || !requestId || !msgChannel || !msgTs) {
        log("button action received with malformed payload");
        return;
      }

      const decision = decidePermissionReplyAction({
        userId,
        approvers: permissionApprovers,
        pendingHas: pendingPermissions.has(requestId),
      });

      if (decision.kind === "forbidden") {
        try {
          await respond({ response_type: "ephemeral", text: "権限がありません" });
        } catch (e) {
          log(`ephemeral respond failed: ${e}`);
        }
        return;
      }

      // Atomic claim (race-safe): get+delete BEFORE emitting verdict
      const entry = pendingPermissions.get(requestId);
      if (!entry) {
        try {
          await client.chat.update({
            channel: msgChannel,
            ts: msgTs,
            text: "期限切れ or 既に処理済み",
            blocks: buildStaleUpdateBlocks() as any,
          });
        } catch (e) {
          log(`chat.update (stale) failed: ${e}`);
        }
        return;
      }
      pendingPermissions.delete(requestId);

      try {
        await mcp.notification({
          method: "notifications/claude/channel/permission",
          params: { request_id: requestId, behavior: verdict },
        });
      } catch (e) {
        log(`verdict notification failed: ${e}`);
      }

      try {
        await client.chat.update({
          channel: entry.channel,
          ts: entry.ts,
          text: `${verdict === "allow" ? "許可" : "拒否"} by <@${userId}>`,
          blocks: buildVerdictUpdateBlocks(userId, verdict, "button") as any,
        });
      } catch (e) {
        log(`chat.update (verdict) failed: ${e}`);
      }

      log(`button verdict: ${verdict} for ${requestId} by ${userId}`);
    });
  }
}

// Listen for messages
slackApp.message(async ({ message }) => {
  // Skip system subtypes (message_changed, message_deleted, etc.)
  // but allow file_share (messages with attachments)
  if (message.subtype && message.subtype !== "file_share") return;

  // Need user field at minimum
  if (!("user" in message) || !message.user) return;

  // Ignore own messages
  if (message.user === botUserId) return;

  // Permission reply routing: checked BEFORE channelFilter/allowFrom so that
  // permissionChannel (which may not be in SLACK_CHANNELS) still works for text fallback.
  if (
    shouldRoutePermissionReply({
      channel: message.channel,
      permissionChannel,
      permissionRelayEnabled,
    })
  ) {
    const incomingText = ("text" in message && message.text) ? message.text : "";
    const parsed = parsePermissionReply(incomingText);
    if (parsed) {
      const messageTs = "ts" in message ? (message.ts as string) : "";
      const decision = decidePermissionReplyAction({
        userId: message.user,
        approvers: permissionApprovers,
        pendingHas: pendingPermissions.has(parsed.requestId),
      });

      if (decision.kind === "forbidden") {
        try {
          await slackApp.client.chat.postMessage({
            channel: message.channel,
            text: "権限がありません",
            ...(messageTs ? { thread_ts: messageTs } : {}),
          });
        } catch (e) {
          log(`thread reply (forbidden) failed: ${e}`);
        }
        return;
      }

      const entry = pendingPermissions.get(parsed.requestId);
      if (!entry) {
        try {
          await slackApp.client.chat.postMessage({
            channel: message.channel,
            text: "⏰ このリクエストは期限切れか既に処理済みです",
            ...(messageTs ? { thread_ts: messageTs } : {}),
          });
        } catch (e) {
          log(`thread reply (stale) failed: ${e}`);
        }
        return;
      }
      pendingPermissions.delete(parsed.requestId);

      try {
        await mcp.notification({
          method: "notifications/claude/channel/permission",
          params: { request_id: parsed.requestId, behavior: parsed.verdict },
        });
      } catch (e) {
        log(`verdict notification failed: ${e}`);
      }

      try {
        await slackApp.client.chat.update({
          channel: entry.channel,
          ts: entry.ts,
          text: `${parsed.verdict === "allow" ? "許可" : "拒否"} by <@${message.user}>`,
          blocks: buildVerdictUpdateBlocks(message.user, parsed.verdict, "text") as any,
        });
      } catch (e) {
        log(`chat.update (text verdict) failed: ${e}`);
      }

      log(`text verdict: ${parsed.verdict} for ${parsed.requestId} by ${message.user}`);
      return;
    }
    // Not a permission reply → fall through to normal chat routing below
  }

  // Gate by channel filter
  if (shouldFilterChannels && !channelFilterSet.has(message.channel)) return;

  // Gate by allowlist
  if (shouldGate && !allowFrom.has(message.user)) return;

  const text = ("text" in message && message.text) ? message.text : "";
  const ts = new Date().toISOString();

  log(`Message from ${message.user} in ${message.channel}: ${text.substring(0, 80)}`);

  const meta: Record<string, string> = {
    chat_id: message.channel,
    user: message.user,
    user_id: message.user,
    ts,
  };

  // Include thread_ts if this is a threaded message
  if ("thread_ts" in message && message.thread_ts) {
    meta.thread_ts = message.thread_ts;
  }

  // Include file attachment info
  if ("files" in message && Array.isArray(message.files) && message.files.length > 0) {
    meta.attachment_count = String(message.files.length);
    meta.attachments = message.files
      .map((f: any) => `${f.name} (${f.mimetype}, ${f.size} bytes, id:${f.id})`)
      .join("; ");
  }

  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: text,
      meta,
    },
  });
});

// Connect MCP to Claude Code (after all handlers are registered)
await mcp.connect(new StdioServerTransport());
log("MCP connected");

// Start Slack app
await slackApp.start();

// Get bot user ID
try {
  const auth = await slackApp.client.auth.test();
  botUserId = auth.user_id as string;
  log(`Connected to Slack as ${auth.user} (${botUserId})`);
} catch (e) {
  log(`Warning: Could not get bot user ID: ${e}`);
}

log("Slack app started (Socket Mode)");
