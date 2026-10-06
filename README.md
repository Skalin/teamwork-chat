# teamwork-chat

A Claude Code mod that brings **Teamwork Chat** into your Claude Code session, so you can keep chatting without switching to the Teamwork web app.

- 🔔 **Unread at a glance**: a band above the prompt, a status line, a toast when a message arrives, and unread cards at the top of the pane
- 💬 **Conversations pane**: your recent conversations as cards, with unread counts and message previews (`/tw`, `/tw unread`)
- ✉️ **Reply and message people**: reply inside a conversation, or start a DM from the pane or with `/tw-dm Name Surname message`
- ✨ **Suggest reply**: Claude drafts your next message from the conversation, in its language, for you to edit and send
- 🖼 **Images and files**: paste an image from the Windows clipboard and send it; images show as previews, files as badges that open in the browser
- 🙈 **Focus mode**: hide the Claude conversation so Teamwork takes the screen (`/tw-focus`)

## Requirements

- Claude Code with the **claude.ai Teamwork.com connector** connected (it is what reads and sends chat messages)
- For sending and previewing images: WSL on Windows (PowerShell reads the clipboard and shrinks pictures), `curl`, and a Teamwork API key (below)
- The fullscreen layout (`"tui": "fullscreen"` in your Claude Code settings) docks the pane as a sidebar; without it the pane opens above the prompt

## Install

At the prompt of a Claude Code session:

```
/plugin install teamwork-chat --marketplace Skalin/teamwork-chat
```

Answer `y` to add the marketplace, then pick a scope.

### API key for images

Images go through Teamwork's own chat API, which needs your API key (Teamwork → your profile → API & Mobile). Put it in `teamwork.env` inside your Claude config folder (`~/.claude/teamwork.env`, or the folder `CLAUDE_CONFIG_DIR` names), readable only by you:

```bash
umask 077
echo 'TEAMWORK_API_KEY=<your key>' > ~/.claude/teamwork.env
```

`TEAMWORK_API_KEY` in the environment works too and wins over the file. Everything else works without a key.

### Permissions in auto mode

In auto mode, give the mod's Teamwork calls an allow rule in your `settings.json`, or the classifier may refuse them:

```json
"permissions": {
  "allow": [
    "mcp__claude_ai_Teamwork_com__twchat-get_current_user",
    "mcp__claude_ai_Teamwork_com__twchat-list_people",
    "mcp__claude_ai_Teamwork_com__twchat-list_conversations",
    "mcp__claude_ai_Teamwork_com__twchat-list_messages",
    "mcp__claude_ai_Teamwork_com__twchat-get_or_create_dm",
    "mcp__claude_ai_Teamwork_com__twchat-send_message",
    "mcp__claude_ai_Teamwork_com__twchat-send_dm"
  ]
}
```

## A status launcher

The chat does not open by itself in ordinary sessions. For a session that is all about status, start Claude with `TEAMWORK_CHAT_DOCK=1` in the fullscreen layout: the mod then docks Teamwork Chat as a wide sidebar right away and keeps the Claude conversation visible beside it. A shell function makes it one command, here also asking Claude for an overview of your scheduled routines:

```bash
claude-status() {
  TEAMWORK_CHAT_DOCK=1 claude --settings '{"tui":"fullscreen"}' "$@" \
    '/schedule list my routines: for each its name, schedule, when it last ran and whether that run succeeded, as one compact table; flag failed runs with the reason. Read only: change nothing.'
}
```

## Commands

| Command | What it does |
| --- | --- |
| `/tw` | Open the Teamwork Chat pane (`/tw unread` for unread only) |
| `/tw-dm <name surname \| @handle> <message>` | Send a direct message |
| `/tw-focus` | Hide or show the Claude conversation |

## Known limits

- Reading a conversation here does not mark it read in Teamwork (the connector has no call for it)
- Messages and attachments cannot be deleted or edited from here
- The terminal draws images as low-resolution cell grids; the link opens the full file
- The image upload uses Teamwork's undocumented chat endpoints, which may change

## Development

`claude --plugin-dir ./teamwork-chat` loads it from this folder (edits reload live), `claude plugin test .` runs the tests and `claude plugin validate .` checks it.
