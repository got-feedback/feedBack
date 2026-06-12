# Contract: Jobs Control Plane

## Domain

`jobs` is an active privileged provider-coordinator capability domain. Core owns command normalization, provider registration, scheduling, diagnostics, and compatibility bridge accounting. Providers own the actual long-running work.

## Owner Registration

The core jobs host registers an owner for `jobs` with:

- `kind`: `provider-coordinator`
- `ownership`: `multi-provider`
- `safety`: `privileged`
- `compatibility`: `shim-allowed`
- `commands`: `register-provider`, `unregister-provider`, `list-providers`, `enqueue`, `list`, `inspect`, `cancel`, `pause`, `resume`, `retry`, `record-bridge-hit`
- `events`: `provider-registered`, `provider-unregistered`, `provider-unavailable`, `queued`, `started`, `progress`, `log`, `paused`, `resumed`, `cancellation-requested`, `cancelled`, `completed`, `failed`, `retried`, `orphaned`, `bridge-hit`

Canonical jobs outcomes: `handled`, `queued`, `denied`, `user-action-required`, `unavailable`, `no-owner`, `no-handler`, `no-target`, `unsupported-command`, `unsupported-operation`, `incompatible`, `incompatible-version`, `provider-selection-required`, `validation-failed`, `stale`, `cancelled`, `completed`, `failed`, `timeout`, and `retry-started`.

## Provider Declaration

A provider participant describes safe metadata only:

```json
{
  "providerId": "sloppak_converter.jobs",
  "pluginId": "sloppak_converter",
  "label": "Sloppak Converter",
  "jobTypes": ["conversion.sloppak"],
  "actions": ["enqueue", "inspect", "cancel", "retry", "recover"],
  "availability": "available",
  "capacity": { "maxRunning": 1, "maxQueued": 10 },
  "recoverySupport": { "queued": true, "running": false, "paused": false }
}
```

Rules:

- `providerId` is stable and unique.
- Re-registering the same provider updates metadata.
- Incompatible providers remain visible in diagnostics but cannot accept new jobs.
- Provider metadata must not include raw local paths, command lines, tokens, native handles, or provider-private payloads.

## Commands

### `register-provider`

Registers or updates a provider.

Required args:

```json
{
  "provider": {
    "providerId": "string",
    "pluginId": "string",
    "label": "string",
    "jobTypes": ["string"],
    "actions": ["enqueue"],
    "capacity": { "maxRunning": 1 }
  }
}
```

Outcomes: `handled`, `validation-failed`, `incompatible-version`, `denied`.

### `unregister-provider`

Unregisters a provider and settles provider-owned active jobs to terminal state.

Required args:

```json
{
  "providerId": "string"
}
```

Rules:

- Command is privileged and host-owned.
- Missing/unknown provider returns `no-owner`.
- Registered provider emits `provider-unregistered`.
- Any active jobs owned by the provider transition to terminal unavailable/orphaned state with a safe reason.

Outcomes: `handled`, `no-owner`, `failed`.

### `list-providers`

Returns redaction-safe provider summaries. Prompt-free and side-effect-free.

Outcomes: `handled`.

### `enqueue`

Requests long-running work.

Required args:

```json
{
  "jobType": "conversion.sloppak",
  "target": { "kind": "song", "id": "target-1" },
  "requester": "core.user",
  "authorization": "user-action",
  "providerId": "optional-provider",
  "priority": "user-approved-interactive",
  "inputs": { "safeFingerprint": "input-fp" }
}
```

Rules:

- Privileged work requires `authorization: "user-action"` or an approved continuation matching provider, job type, target, requester, and inputs.
- Missing or mismatched approval returns `denied` or `user-action-required` before provider operation callbacks run.
- If exactly one compatible provider exists, it MUST be selected automatically.
- If multiple compatible providers exist, `providerId` or selected/default provider is required; otherwise return `provider-selection-required`.
- Validation happens before provider work starts.
- Provider capacity controls whether the job enters `queued` or `running`.

Outcomes: `queued`, `handled`, `denied`, `user-action-required`, `provider-selection-required`, `validation-failed`, `unavailable`, `no-owner`, `no-handler`, `unsupported-operation`, `incompatible`, `incompatible-version`, `failed`.

### `list`

Returns summaries for active, queued, paused, and recent terminal jobs. Prompt-free and side-effect-free; it must not invoke provider work callbacks, file writes, downloads, subprocesses, or external-service calls.

Filters may include `providerId`, `jobType`, `state`, `requesterId`, and `includeTerminal`.

Outcomes: `handled`.

### `inspect`

Returns one job, provider, progress, attempt, action availability, and safe diagnostic context. Prompt-free and side-effect-free; it must not invoke provider work callbacks, file writes, downloads, subprocesses, or external-service calls.

Required args: `{ "jobId": "string" }`

Outcomes: `handled`, `unavailable`, `no-target`.

### `cancel`

Cancels queued jobs immediately or requests cancellation for running/paused jobs.

Required args: `{ "jobId": "string", "requester": "string" }`

Rules:

- Queued jobs transition to `cancelled` and must not start later.
- Running jobs transition to `cancellation-requested` until provider terminal report.
- Unsupported cancellation returns `unsupported-operation` without changing state.
- Late cancellation after terminal state returns `stale` or the current terminal status.

Outcomes: `handled`, `cancelled`, `stale`, `unsupported-operation`, `unavailable`, `no-target`, `failed`.

### `pause`

Requests pause for a running job when provider supports it.

Outcomes: `handled`, `unsupported-operation`, `stale`, `unavailable`, `no-target`, `failed`.

### `resume`

Returns a paused job to queued or running state with the same job identity.

Outcomes: `handled`, `queued`, `unsupported-operation`, `stale`, `unavailable`, `no-target`, `failed`.

### `retry`

Creates a retry attempt for a terminal retryable job.

Required args:

```json
{
  "jobId": "string",
  "requester": "string",
  "authorization": "user-action | approved-continuation"
}
```

Rules:

- Retry is allowed only for terminal jobs marked retryable or safely re-enqueueable with the same approved provider, job type, target, requester, and inputs.
- A retry creates a new attempt linked to the original job.
- Only one active retry attempt may exist at a time.

Outcomes: `retry-started`, `queued`, `denied`, `user-action-required`, `validation-failed`, `stale`, `unsupported-operation`, `unavailable`, `no-target`, `failed`.

### `record-bridge-hit`

Records legacy queue/status/backend-route usage for diagnostics.

Outcomes: `handled`.

## Events

Events are emitted as `jobs:<event>` through `window.slopsmith.emit` and mirrored into capability diagnostics.

Event payloads use redaction-safe ids and summaries only. They must not contain raw artifacts, command lines, local paths, tokens, native handles, subprocess handles, downloaded payloads, or plugin-private objects.

Required events:

- `jobs:provider-registered`
- `jobs:provider-unavailable`
- `jobs:queued`
- `jobs:started`
- `jobs:progress`
- `jobs:log`
- `jobs:paused`
- `jobs:resumed`
- `jobs:cancellation-requested`
- `jobs:cancelled`
- `jobs:completed`
- `jobs:failed`
- `jobs:retried`
- `jobs:orphaned`
- `jobs:bridge-hit`

## Provider Operations

Provider operation handlers are implementation-owned callbacks registered by providers. Public commands call these operations only after validation, scheduling, and approval checks.

Expected operations:

- `job.enqueue`
- `job.status`
- `job.cancel`
- `job.pause`
- `job.resume`
- `job.retry`
- `job.recover`

Provider operation results must use normalized states/outcomes and safe reasons. Malformed provider responses produce `failed` or `validation-failed` outcomes and do not expose provider-private data.
