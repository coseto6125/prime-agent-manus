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
export MANUS_API_KEY=sk-...
```

Try it without installing:

```bash
prime-agent -e git:github.com/coseto6125/prime-agent-manus --provider manus --model manus-1.6-lite
```

Get an API key from the [Manus API console](https://open.manus.ai). Instead of the environment
variable you can set the key in `~/.prime/agent/models.json`, including the `!command` form:

```json
{
  "providers": {
    "manus": { "apiKey": "!op read op://private/manus/api-key" }
  }
}
```

## Configuration

| Environment variable | Effect |
|---|---|
| `MANUS_API_KEY` | API key. Required unless set through provider config. |
| `MANUS_PROJECT_ID` | Files every task under a Manus project instead of your personal task list. |

Model ids are Manus `agent_profile` values. `manus-1.6-lite` is cheaper and faster; a short question
answers in roughly 7 to 10 seconds. Read the next section before choosing anything else.

## manus-1.6 and manus-1.6-max may not work at all

On the account this was built against, `task.create` returns `ok: true` with a `task_id` for every
profile, but **only `manus-1.6-lite` produces a task that actually exists**. For `manus-1.6` (which
is also the API default) and `manus-1.6-max`, the returned id is unknown to `task.detail` and
`task.listMessages` forever, and the task never appears in `task.list` — not even when filtering by
the creating `api_key_id`. Verified across interleaved runs of both profiles minutes apart, before
and after a credit refresh, with both accepted auth headers.

The API reference notes that "free personal accounts are downgraded to `manus-1.6-lite` regardless
of the requested value", so this looks like that downgrade path failing instead of downgrading.
Whether paid accounts are affected is untested.

Rather than surfacing a bare `task not found`, this extension polls for a grace period and then
fails with a message naming the cause and pointing at `manus-1.6-lite`. If the non-lite profiles
work on your account, they work here too; nothing is blocked client-side.

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
