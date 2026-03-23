# claude-slack-channel

Claude Code の [Channels](https://code.claude.com/docs/en/channels-reference) 機能を使って、Slack と双方向通信するプラグインです。

Slack チャンネルに投稿されたメッセージが Claude Code セッションにリアルタイムで届き、Claude が reply ツールで Slack に返信できます。Socket Mode を使用するため、公開 URL は不要です。

## 必要なもの

- [Bun](https://bun.sh) (v1.3 以上推奨)
- Claude Code v2.1.80 以上
- Slack ワークスペースの管理権限（App 作成用）

## Slack App のセットアップ

### 1. Slack App の作成

[Slack API](https://api.slack.com/apps) で「Create New App」→「From scratch」。

### 2. Socket Mode の有効化

左メニュー「Socket Mode」→ 有効にする → App-Level Token を生成:
- Token Name: 任意（例: `claude-channel`）
- Scope: `connections:write`
- 生成された `xapp-...` トークンを控える

### 3. Event Subscriptions の設定

左メニュー「Event Subscriptions」→ 有効にする。

「Subscribe to bot events」で以下を追加:
- `message.channels` — パブリックチャンネルのメッセージ
- `message.im` — ダイレクトメッセージ（必要な場合）

### 4. Bot Token Scopes の設定

左メニュー「OAuth & Permissions」→「Scopes」→「Bot Token Scopes」で以下を追加:
- `channels:history` — チャンネルのメッセージ読み取り
- `channels:read` — チャンネル情報の読み取り
- `chat:write` — メッセージ送信
- `files:read` — 添付ファイルのダウンロード
- `files:write` — ファイルのアップロード
- `im:history` — DMの読み取り（必要な場合）
- `im:read` — DM情報の読み取り（必要な場合）

### 5. ワークスペースにインストール

「OAuth & Permissions」→「Install to Workspace」→ 許可。

表示される `xoxb-...` トークン（Bot User OAuth Token）を控える。

### 6. Bot をチャンネルに招待

Slack で対象チャンネルに移動し:
```
/invite @your-bot-name
```

## プラグインのセットアップ

### 1. 依存パッケージのインストール

```bash
cd claude-slack-channel
bun install
```

### 2. トークンの設定

`.env` ファイルを作成:

```bash
cp .env.example .env
```

`.env` を編集:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-level-token
```

### 3. Claude Code の起動

```bash
claude --dangerously-load-development-channels server:slack
```

## 別のプロジェクトから参照

プロジェクトの `.mcp.json` または `~/.claude.json` に追加:

```json
{
  "mcpServers": {
    "slack": {
      "command": "bun",
      "args": ["run", "--cwd", "C:\\path\\to\\claude-slack-channel", "--shell=bun", "--silent", "start"]
    }
  }
}
```

> **重要:** `"args": ["C:/path/to/server.ts"]` のように直接パスを指定すると、Bun が生成する User-Agent に非 ASCII 文字が含まれ、Slack API 呼び出しが失敗します。`bun run --cwd <dir> start` 形式を使ってください。

## 環境変数による設定

| 環境変数 | 説明 | 必須 |
|---------|------|------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) | Yes |
| `SLACK_APP_TOKEN` | App-Level Token (`xapp-...`) | Yes |
| `SLACK_CHANNELS` | メッセージを受け付けるチャンネル ID（カンマ区切り）。空 = 全チャンネル | No |
| `SLACK_ALLOW_FROM` | メッセージを受け付けるユーザー ID（カンマ区切り）。空 = 全員 | No |

`config.json` でもデフォルト値を設定できます:

```json
{
  "channels": ["C01XXXXXXXX"],
  "allowFrom": ["U01XXXXXXXX"]
}
```

環境変数が優先されます。

## 他のチャンネルとの併用

`--channels` はスペース区切りで複数指定できます:

```bash
claude --channels plugin:discord@claude-plugins-official --dangerously-load-development-channels server:slack
```

## メッセージの流れ

```
Slack ワークスペース                Claude Code セッション
     │                                      │
     │  #general: こんにちは                 │
     │  ──────(Socket Mode)──────────────►  │
     │         (server.ts が中継)            │
     │                                      │  <channel source="slack"
     │                                      │   chat_id="C01XXX"
     │                                      │   user="U01XXX">
     │                                      │  こんにちは
     │                                      │  </channel>
     │                                      │
     │                                      │  → Claude が reply ツールを呼ぶ
     │  #general: こんにちは！               │
     │  ◄──────(Web API)─────────────────  │
     │                                      │
```

## スレッド対応

スレッド内のメッセージには `thread_ts` が付与されます。reply ツールで `thread_ts` を渡すとスレッド内に返信します。

## ファイル構成

```
claude-slack-channel/
├── server.ts      # MCP サーバー + Slack Bolt
├── config.json    # デフォルト設定
├── .env.example   # 環境変数テンプレート
├── .env           # トークン（.gitignore 対象）
├── .mcp.json      # Claude Code 用 MCP サーバー定義
├── package.json   # 依存パッケージ
└── README.md      # このファイル
```

## 添付ファイル

添付ファイル付きメッセージを受信すると、`attachment_count` と `attachments`（ファイル名/MIME/サイズ/ID）が通知に含まれます。

- `download_attachment` — file_id を指定してファイルをダウンロード（`inbox/` に保存）
- `upload_file` — ローカルファイルを Slack チャンネルにアップロード

## 制限事項

- Channels 機能はリサーチプレビュー中のため、`--dangerously-load-development-channels` フラグが必要です
- リアクションの追加・メッセージ編集には未対応
- Bot がチャンネルに招待されていないとメッセージを受信できません

## ライセンス

MIT
