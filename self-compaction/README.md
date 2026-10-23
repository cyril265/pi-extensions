# self-compaction

Compacts a session by asking the session itself to write the summary.

Pi's default compaction serializes the old messages into text, cuts each tool result to 2000
characters, and sends that text to the model as a new conversation with its own system prompt.
That request shares no prefix with the session, so the provider cache cannot help, and the model
sees a shortened copy of the work.

This extension sends the session's own request instead: the same system prompt, tools, and
messages the last turn sent, plus one user message asking for a handoff. It uses the same
model, session id, thinking level, thinking budgets, transport, and cache retention as the session.
The request passes through the same `before_provider_request` and `before_provider_headers`
handlers as a session request, so extensions that rewrite the provider payload, such as
`pi-claude-code-use` for Anthropic subscription logins, apply to it too.
Like Pi's own compaction since 1.4.0, the summary may use the model's full output limit, reduced
to what still fits the context window, so long reasoning does not cut it off.
The provider then reads the existing conversation from its prompt cache and only processes the new
tail, and the model summarizes the full tool results and its own reasoning context.

## Install

```json
{
  "packages": ["/absolute/path/to/pi-extensions/self-compaction"]
}
```

Then run `/reload`. It handles `/compact` (including `/compact <focus>`) and threshold
auto-compaction.

## How it works

1. A `context_with_system` handler records the projected transcript of every session request,
   after the `context` handlers of other extensions have run, such as `tool-result-trim`.
2. On `session_before_compact`, it appends the session messages added since that request, such as
   the assistant reply and tool results, and asks: "Your context is being compacted. Write a
   handoff message to yourself: after this, you will only see this handoff and the most recent
   messages. Earlier summaries are dropped too. Do not call tools." `/compact <focus>` adds the
   focus.
   No summary format is imposed; the model writes the handoff its own way.
3. It sends that request through the session's extension runner, which runs the
   `before_provider_request` and `before_provider_headers` handlers as Pi does for session
   requests. Pi does not do this for extension model calls, so the extension wraps
   `ExtensionRunner.prototype.createContext` to learn which runner created the compaction's
   context.
4. It keeps Pi's `firstKeptEntryId`, so recent messages stay verbatim as with the default.
5. The summary carries read and modified file lists like Pi's default compaction, accumulated
   across earlier self-compactions.

The compaction entry's `details` holds
`{ method: "self-compaction", readFiles, modifiedFiles, source }`. `source` is `projection` when
the recorded request was replayed, and `session` when no request had been recorded yet (for
example right after `/reload`), in which case it sends the raw session transcript.

## Falls back to default compaction when

- the compaction is overflow recovery, because the context no longer fits the model
- less than 80% of `reserveTokens` (or the model's output limit, if smaller) would be left in the
  context window for the summary
- there is no current model
- the request fails, the model calls a tool, the summary is empty, or the summary hits the output
  limit and is cut off

## Limits

- If a Pi release stops creating extension contexts through `ExtensionRunner.prototype.createContext`,
  the summary request skips the provider hooks as Pi's own compaction does. With an Anthropic
  subscription login and `pi-claude-code-use`, that request then fails with "Third-party apps now
  draw from extra usage", and default compaction runs instead.
- Another extension that also answers `session_before_compact`, such as `pi-openai-compaction`,
  competes with this one. Load only one of them per model.

## Test

```bash
npm install
npm run typecheck
npm run test:live
```

`test:live` spends a few small calls on `openai-codex/gpt-5.6-luna`, `anthropic/claude-haiku-5-5`
and `anthropic/claude-opus-5`. It needs existing OpenAI Codex and Anthropic logins. It checks that
a `context` transform reaches the summary, which shows the projected request was replayed, that a
`before_provider_request` rewrite reaches it, that the summary request includes the reply the
session received after its last request, and that the compaction's cache reads cover the
session's cached prefix. Those sessions set `reserveTokens` to 100, so a summary capped by
`reserveTokens` would be cut off. Another test reopens the session in a new runtime, as after a
restart, and compacts before any request: the rewrite must still reach the summary request. A last
test gives the model an 8-token output limit and checks that the cut-off summary is not saved.
