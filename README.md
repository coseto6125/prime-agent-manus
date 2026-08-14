# prime-agent-manus

Use [Manus](https://manus.im) as a model provider inside
[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) and any pi-based agent.

Manus ships no terminal CLI and its API is not OpenAI-compatible, so no built-in adapter reaches it.
This extension registers `manus` as a provider with a custom `streamSimple`, and bridges Prime
Agent's tools into the prompt so Manus can act on your machine: it reads files, runs commands, edits
code, and checks its own work.

```
/model → Manus 1.6 Lite, Manus 1.6, Manus 1.6 Max
```

## What to expect

**A toy, and a decent reviewer.** It works, but two limits keep it away from real coding work:

- **5000 estimated tokens per message.** A `task.create` or `task.sendMessage` body over that is
  rejected outright. It caps how much of a file, and how much of the conversation, Manus can be
  shown at once. (It caps one *message*, not the task: a Manus task keeps its own history, so what
  it has already read stays with it across turns.)
- **30 to 60 seconds per tool call.** Manus is an asynchronous cloud agent, reached by creating a
  task and polling it. Adding one function to one file takes about 90 seconds. Twenty tool calls
  take half an hour.

Where that stops mattering is review: it needs no long context per step, latency does not matter,
and it finds real things. Three of the fixes in this repository's history came from Manus reviewing
it through this bridge.

For writing code, keep a real coding model selected.

## Install

```bash
prime-agent package install git:github.com/coseto6125/prime-agent-manus
```

Create a key at the [Manus API console](https://open.manus.ai), then pick one:

- **`/login` (recommended).** In the TUI run `/login`, choose **Manus (API key)**, paste the key.
  It is checked against the API on entry and stored in `~/.prime/agent/auth.json`.
- **Environment.** `export MANUS_API_KEY=sk-...`
- **Provider config.** `~/.prime/agent/models.json`, which takes the `!command` form so the key can
  live in a password manager: `{"providers": {"manus": {"apiKey": "!op read op://private/manus/key"}}}`

Try it without installing:

```bash
prime-agent -e git:github.com/coseto6125/prime-agent-manus --provider manus --model manus-1.6-lite
```

Extensions load at startup, so after installing or updating, restart or run `/reload`.

## Configuration

| Environment variable | Effect |
|---|---|
| `MANUS_API_KEY` | API key. Required unless set through provider config. |
| `MANUS_PROJECT_ID` | Files every task under a Manus project instead of your personal task list. |
| `MANUS_TOOL_BRIDGE` | `0` turns off tool bridging, leaving Manus as a text model that touches nothing. |

## Check which profiles your account can create

Model ids are Manus `agent_profile` values. The API reference says free personal accounts are
"downgraded to `manus-1.6-lite`". What was observed instead is that no task is created at all:
`task.create` returns `ok: true` and a `task_id` for every profile, but for `manus-1.6` and
`manus-1.6-max` that id stays unknown to `task.detail` and `task.listMessages` forever, never
reaches `task.list`, and moves no credits. Only `manus-1.6-lite` produced a task that exists. The
same account runs `manus-1.6` normally in the web app, so this is about the API path.

Nothing is blocked client-side. Check yours:

```bash
TASK=$(curl -s -X POST https://api.manus.ai/v2/task.create \
  -H "x-manus-api-key: $MANUS_API_KEY" -H 'Content-Type: application/json' \
  -d '{"message":{"content":"hi"},"agent_profile":"manus-1.6","hide_in_task_list":true}' \
  | grep -o '"task_id":"[^"]*"' | cut -d'"' -f4)
sleep 10 && curl -s "https://api.manus.ai/v2/task.detail?task_id=$TASK" -H "x-manus-api-key: $MANUS_API_KEY"
```

`ok: true` means the profile works for you; `task not found` means you hit the same thing. A turn
against such a task fails with a message naming the cause rather than a bare `task not found`.

Beware that a live task hides this: `agent_profile` is fixed at creation and follow-up turns go to
`task.sendMessage` regardless of the model selected, so switching mid-conversation can look like it
works. This extension keys its task cache on model id to prevent that.

## How it works

Manus has no streaming endpoint. A turn creates a task (or sends to the live one), polls
`task.listMessages`, and forwards each new assistant message as a text delta, so Manus's own
progress narration renders while the task runs.

Tools are bridged rather than native. The first message carries the calling protocol and a catalog
of every tool with its JSON Schema; later turns carry a one-line reminder. A reply is scanned for a
call as a ` ```tool_call ` fence, any JSON fence naming a tool, or a bare `{"tool": …}` object in
the prose, with raw newlines inside JSON strings escaped first (a call carrying a shell script is
otherwise unparseable). On a hit the turn ends with `stopReason: "toolUse"`, Prime Agent runs the
tool locally, and the result reaches the same task through `task.sendMessage`.

Most of the preamble exists to stop Manus doing the work in its own sandbox, where it would edit a
file that only exists on its side and report success for a change your repository never received.

Every message is measured against the 5000-token ceiling and trimmed: the catalog degrades from full
schemas to schemas without prose to one signature per tool, tool results are cut in the middle to
keep both ends, and the oldest messages go first so this turn's instruction survives. The estimate
counts ASCII at four characters per token and everything else at two, because undershooting costs
the whole request.

Other behaviour worth knowing:

- Files Manus builds arrive as attachments, appended to the reply as markdown links. The signed URLs
  expire, so download what you want to keep.
- Aborting calls `task.stop`, so an abandoned task stops burning credits.
- A task can pause in `waiting` status for an approval only the Manus app can collect (terminal,
  mail, deploy). The turn ends with a note and a link instead of a truncated answer.
- The host system prompt is not forwarded; Manus reads it as an attachment to go and open. Pass
  `includeSystemPrompt: true` to `createManusStream` to override.

## Limits

- **One tool call per turn.** Manus often plans several steps in one reply; the first runs and the
  rest are proposed again with the result in hand.
- **A missed call is just text.** A reply that ignores the protocol reads as prose and recovers on
  the next turn. Nothing is corrupted.
- **No token usage or cost.** Manus bills in credits and reports no token counts, so the cost
  readout stays at zero.
- **Text-only input.** Images are replaced with a placeholder.
- **Task reuse is per process**, keyed on model id plus the first user message.

## Notes on the Manus API

Documented here because the official reference is thin on both.

`structured_output_schema` follows OpenAI strict-mode rules, and a violation comes back as a generic
`invalid_argument` at task creation: every object needs `additionalProperties: false`, every
`required` must list **all** of that object's properties (use `"type": ["string", "null"]` for
optional ones), and the schema goes in bare rather than wrapped as `{name, schema}`.

Authentication uses the `x-manus-api-key` header. `Authorization: Bearer` is for OAuth tokens and
rejects an API key with "token contains an invalid number of segments".

## Development

```bash
npm install
npm test

# live tests against the real API; creates tasks and spends credits
MANUS_LIVE_TEST=1 MANUS_API_KEY=sk-... npx vitest run test/live.test.ts
```

## License

MIT
