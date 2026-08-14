# prime-agent-manus

Use [Manus](https://manus.im) as a model provider inside [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) (and any pi-based agent).

Manus ships no terminal CLI and its API is not OpenAI-compatible, so none of Prime Agent's built-in
API adapters reach it. This extension registers `manus` as a provider with a custom `streamSimple`,
which presents Manus's asynchronous task API as an ordinary assistant stream.

```
/model → Manus 1.6 Lite, Manus 1.6, Manus 1.6 Max
```

## Read this before installing

**Manus answers; it does not use your tools.** The Manus API accepts no caller-supplied tool or
function definitions, and Manus works inside its own cloud sandbox with no access to your machine.
Through this provider Manus behaves as a knowledgeable text model: it will not read your files, run
your tests, or edit your repository, whatever the surrounding agent's system prompt says.

Use it for research, review, explanation, and planning. Keep a real coding model selected for edits.

## Install

```bash
prime-agent package install git:github.com/coseto6125/prime-agent-manus
```

Then authenticate. Create a key at the [Manus API console](https://open.manus.ai) and pick one of:

**`/login` (recommended).** In the TUI, run `/login`, choose **Manus (API key)**, and paste the key.
It is checked against the API on entry and stored in `~/.prime/agent/auth.json`, so nothing lives in
your shell profile. `/login manus` jumps straight to it.

**Environment variable.** `export MANUS_API_KEY=sk-...` before launch.

**Provider config.** `~/.prime/agent/models.json`, which also takes the `!command` form so the key
can stay in a password manager:

```json
{
  "providers": {
    "manus": { "apiKey": "!op read op://private/manus/api-key" }
  }
}
```

Try it without installing:

```bash
prime-agent -e git:github.com/coseto6125/prime-agent-manus --provider manus --model manus-1.6-lite
```

Extensions load when Prime Agent starts, so after installing or updating this package, restart it or
run `/reload`.

## Configuration

| Environment variable | Effect |
|---|---|
| `MANUS_API_KEY` | API key. Required unless set through provider config. |
| `MANUS_PROJECT_ID` | Files every task under a Manus project instead of your personal task list. |

Model ids are Manus `agent_profile` values. `manus-1.6-lite` is cheaper and faster; a short question
answers in roughly 7 to 10 seconds. Read the next section before choosing anything else.

## Check which profiles your account can actually create

The API reference states, under `agent_profile`:

> Free personal accounts are downgraded to `manus-1.6-lite` regardless of the requested value.

What happens instead is that no task is created at all. On a free personal account, `task.create`
returns `ok: true` with a `task_id` for every profile, but only `manus-1.6-lite` produced a task that
exists. For `manus-1.6` (also the API default) and `manus-1.6-max`, the returned id stayed unknown to
`task.detail` and `task.listMessages` indefinitely, the task never appeared in `task.list` even when
filtering by the creating `api_key_id`, and `usage.list` recorded no credit movement for it. The v1
endpoint `POST /v1/tasks`, which takes no profile parameter and therefore uses the `manus-1.6`
default, behaves the same way.

This is about the API path only. The same account runs `manus-1.6` normally in the Manus web app.

Nothing is blocked client-side, so if the other profiles work for you they work here. Check yours in
two commands:

```bash
TASK=$(curl -s -X POST https://api.manus.ai/v2/task.create \
  -H "x-manus-api-key: $MANUS_API_KEY" -H 'Content-Type: application/json' \
  -d '{"message":{"content":"hi"},"agent_profile":"manus-1.6","hide_in_task_list":true}' \
  | grep -o '"task_id":"[^"]*"' | cut -d'"' -f4)
sleep 10 && curl -s "https://api.manus.ai/v2/task.detail?task_id=$TASK" -H "x-manus-api-key: $MANUS_API_KEY"
```

`ok: true` means the profile works for you. `task not found` means you hit the same thing.

**A live task hides this.** A Manus task's `agent_profile` is fixed when it is created, and follow-up
turns go to `task.sendMessage`, which works regardless of the model currently selected. So switching
to `manus-1.6` mid-conversation can look like it works while the reply still comes from the original
task. This extension keys its task cache on model id to prevent that, but it is worth knowing when
reading anyone else's report of the behaviour, including your own.

When a created task never becomes readable, the turn fails with a message naming the cause instead of
a bare `task not found`.

## How it works

Manus has no streaming endpoint. One turn looks like this:

1. Flatten the conversation into text and `POST /v2/task.create`.
2. Poll `GET /v2/task.listMessages` and forward every new assistant message as a text delta, so
   Manus's own progress narration renders while the task is still running.
3. Stop when the newest `status_update` leaves `running`.

Follow-up turns inside one process reuse the same Manus task through `task.sendMessage`, so the task
keeps its own history and only unseen messages are sent. A new process starts a new task and replays
the transcript, which costs an extra task but keeps the answer correct. Switching model also starts a
new task, because a task's `agent_profile` is fixed when it is created.

Files Manus builds (images, video, documents, generated code) come back as attachments rather than
in the message text, which usually just says "see the attachment". Each one is appended to the reply
as a labelled signed CDN link:

```
[penguin.png · image/png]
https://private-us-east-1.manuscdn.com/sessionFile/...
```

Those links carry an expiry in their signature policy, so download anything you want to keep.

Aborting the turn calls `task.stop`, so an abandoned task stops burning credits.

The host's system prompt is **not** forwarded by default. Prime Agent's system prompt describes its
own tool environment, and Manus reads that as an attachment it should go and open. Pass
`includeSystemPrompt: true` to `createManusStream` if you want it anyway.

## Limits

- **No tool calling.** See above. Prime Agent's tool definitions are dropped.
- **No token usage or cost.** Manus bills in credits, not tokens, and returns no token counts, so
  the cost readout stays at zero. Check credit usage in the Manus dashboard.
- **Text-only input.** Images you send are replaced with a placeholder.
- **Task reuse is per process**, keyed on model id plus the first user message. Two conversations
  that open with byte-identical text on the same model share a task within one process.

## Notes on the Manus API

Documented here because the official reference is thin on both points.

`structured_output_schema` follows OpenAI strict-mode rules, and violations come back as a generic
`invalid_argument` / "unexpected error from node server" at task creation:

- every object needs `additionalProperties: false`
- every object's `required` must list **all** of its properties (use `"type": ["string", "null"]`
  for optional ones)
- the schema goes in bare; wrapping it as `{ "name": ..., "schema": ... }` is rejected

Authentication uses the `x-manus-api-key` header. `Authorization: Bearer` is for OAuth tokens and
rejects an API key with "token contains an invalid number of segments".

## Roadmap

Bridging tools through `structured_output_schema` is the obvious next step: describe the caller's
tools as a strict schema, and translate a structured reply into a `toolCall` event. Manus returns
structured results in a dedicated `structured_output_result` message, so the plumbing works. The
open question is behavioural, not technical, since an autonomous agent prefers to finish the job
itself rather than stop and ask the caller to run one step.

## Development

```bash
npm install
npm test

# live tests against the real API; creates tasks and spends credits
MANUS_LIVE_TEST=1 MANUS_API_KEY=sk-... npx vitest run test/live.test.ts
```

## License

MIT
