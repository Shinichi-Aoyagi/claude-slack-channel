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

// Inbox directory for downloaded files
const inboxDir = join(import.meta.dir, "inbox");
mkdirSync(inboxDir, { recursive: true });

// stderr for debug logging (stdout is reserved for MCP stdio)
const log = (msg: string) => console.error(`[slack-channel] ${msg}`);

// Create MCP server
const mcp = new Server(
  { name: "slack", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
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

// Connect MCP to Claude Code
await mcp.connect(new StdioServerTransport());
log("MCP connected");

// Create Slack app with Socket Mode
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

// Listen for messages
slackApp.message(async ({ message, say }) => {
  // Skip system subtypes (message_changed, message_deleted, etc.)
  // but allow file_share (messages with attachments)
  if (message.subtype && message.subtype !== "file_share") return;

  // Need user field at minimum
  if (!("user" in message) || !message.user) return;

  // Ignore own messages
  if (message.user === botUserId) return;

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

// Start the app
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
