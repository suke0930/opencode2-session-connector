# opencode2-session-connector

Validated session-to-session messaging for OpenCode, built on the native session API.

OpenCode already durably admits session prompts. This plugin adds the two things
the native API cannot:

- a **validated destination** for a send, and
- a **reply path that resolves its destination from a stored request**, instead of
  trusting a session id typed into a message body.

## Tools

| Tool | Purpose |
| --- | --- |
| `session_create` | Create a session and return its id. Omitting `directory` uses the calling session's directory. |
| `session_send` | Send text to an exact session id and return a `request_id`. Never guesses a destination. |
| `session_reply` | Reply using only `request_id`. No session id is accepted. |
| `session_message_status` | Report request status; visible only to the two participant sessions. |

## Install

Add the directory to `plugins` in `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode2-session-connector"]
}
```

The plugin has no runtime dependencies and is loaded directly from `index.ts`.

## How it works

`session_send` records `request_id -> { fromSessionId, toSessionId }` in the
plugin's own storage and delivers the message with a header carrying the request
id. The receiving session replies with `session_reply(request_id, text)`; the
plugin resolves the destination and rejects any caller that is not the session
the request was addressed to. A reply cannot be forged by writing a name into the
message body.

Direct API calls made outside this plugin are not restricted by it.

## Test

```sh
npm test
```
