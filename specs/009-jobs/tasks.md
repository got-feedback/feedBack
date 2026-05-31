# Tasks: Jobs Control Plane

**Input**: Design documents from `/specs/009-jobs/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Tests are included because the plan and testing contract explicitly require focused Node JS tests, diagnostics/redaction tests, inspector rendering tests, and smoke validation.

**Organization**: Tasks are grouped by user story so each story can be implemented and tested as an independent increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files and does not depend on incomplete tasks
- **[Story]**: Which user story this task belongs to (`US1`, `US2`, `US3`, `US4`)
- Every task includes at least one exact repository file path

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the jobs capability host entry points and test harness scaffolding used by all stories.

- [X] T001 Create jobs capability host shell with IIFE, event-bus access, diagnostics contribution placeholder, and public namespace in static/capabilities/jobs.js
- [X] T002 Load the jobs capability host after the capability runtime in static/index.html
- [X] T003 [P] Create jobs Node VM test harness with helpers for loading capabilities, dispatching jobs commands, capturing events, and reading diagnostics in tests/js/jobs_test_harness.js
- [X] T004 [P] Add jobs test file placeholders importing the harness in tests/js/jobs_domain.test.js, tests/js/jobs_scheduling.test.js, tests/js/jobs_diagnostics.test.js, and tests/js/jobs_compat.test.js
- [X] T005 [P] Add jobs inspector render fixture placeholders in tests/js/capability_inspector_render.test.js

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish shared capability metadata, normalized state primitives, provider registration, and snapshot plumbing that every user story depends on.

**CRITICAL**: No user story work can begin until this phase is complete.

- [X] T006 Promote `jobs` from reserved future domain to active privileged provider-coordinator review metadata in static/capabilities.js
- [X] T007 Add or verify the canonical jobs outcome inventory from FR-005 in capability outcome normalization in static/capabilities.js
- [X] T008 Implement constants for job states, outcomes, actions, priorities, limits, bridge ids, and diagnostics schema in static/capabilities/jobs.js
- [X] T009 Implement redaction and safe-value helpers for labels, reasons, target refs, logs, command-like text, URLs, local paths, and provider payloads in static/capabilities/jobs.js
- [X] T010 Implement provider, selected-provider, job, attempt, progress, outcome, history, and bridge in-memory stores with resettable test hooks in static/capabilities/jobs.js
- [X] T011 Implement diagnostics snapshot builder with active/queued/paused/recent terminal grouping and 64 KB budget trimming in static/capabilities/jobs.js
- [X] T012 Implement jobs capability owner registration with command/event declarations and diagnostics contribution in static/capabilities/jobs.js
- [X] T013 Add foundational harness assertions for active jobs owner registration, diagnostics schema, reset hooks, and no raw-provider-payload exposure in tests/js/jobs_domain.test.js
- [X] T014 [P] Add static idempotence expectations for active jobs domain and new outcomes in tests/test_plugin_runtime_idempotence.py

**Checkpoint**: Jobs domain loads, registers as active privileged provider-coordinator, and can produce an empty redaction-safe diagnostics snapshot.

---

## Phase 3: User Story 1 - Track Long-Running Work (Priority: P1) MVP

**Goal**: A user can see long-running work as jobs with provider/requester attribution, current state, progress, completion, and safe diagnostics.

**Independent Test**: Register a representative provider, enqueue a user-approved job, report progress, complete it, and confirm `list`, `inspect`, events, and diagnostics describe the same state.

### Tests for User Story 1

- [X] T015 [US1] Add provider registration, re-registration idempotence, unavailable/degraded provider, and incompatible provider tests in tests/js/jobs_domain.test.js
- [X] T016 [US1] Add user-approved enqueue, privileged enqueue without approval returning denied/user-action-required before provider work starts, side-effect-free list/inspect, queued/running state, no-owner, unavailable, and validation-failed tests in tests/js/jobs_domain.test.js
- [X] T017 [US1] Add determinate progress, indeterminate progress, stale progress after terminal state, completion, and safe result summary tests in tests/js/jobs_domain.test.js
- [X] T018 [P] [US1] Add Capability Inspector jobs provider/progress/current-job rendering tests in tests/js/capability_inspector_render.test.js

### Implementation for User Story 1

- [X] T019 [US1] Implement `register-provider`, `unregister-provider`, `list-providers`, provider validation, and idempotent provider updates in static/capabilities/jobs.js
- [X] T020 [US1] Implement `enqueue` validation for one compatible provider, explicit user-action or approved-continuation authorization before provider dispatch, provider availability, provider operation dispatch, job creation, queued/running state, and denied/user-action-required/no-owner/no-handler/unavailable outcomes in static/capabilities/jobs.js
- [X] T021 [US1] Implement side-effect-free `list` and `inspect` command summaries for providers, jobs, progress, attempts, actions, timestamps, and safe reasons without invoking provider work callbacks in static/capabilities/jobs.js
- [X] T022 [US1] Implement provider progress and log update ingestion with determinate, indeterminate, step-only, decreasing-progress, and stale-after-terminal handling in static/capabilities/jobs.js
- [X] T023 [US1] Implement provider completion and failure result normalization with terminal outcomes, retryability, result summaries, and active-state cleanup in static/capabilities/jobs.js
- [X] T024 [US1] Emit `jobs:provider-registered`, `jobs:queued`, `jobs:started`, `jobs:progress`, `jobs:log`, `jobs:completed`, and `jobs:failed` lifecycle events in static/capabilities/jobs.js
- [X] T025 [US1] Render jobs provider cards, active/queued jobs, progress, action availability, and recent outcomes in plugins/capability_inspector/screen.js
- [X] T026 [US1] Load and smoke-check jobs host script ordering with index integration in static/index.html

**Checkpoint**: User Story 1 is independently functional; a single provider can enqueue, progress, complete/fail, and appear in diagnostics and inspector.

---

## Phase 4: User Story 2 - Cancel, Pause, Resume, And Retry Jobs (Priority: P2)

**Goal**: A user can cancel queued/running jobs, pause/resume supported jobs, and retry retryable terminal jobs without ambiguous state.

**Independent Test**: Run jobs that support or reject cancellation, pause, resume, and retry, then verify each command produces a distinct outcome and preserves job/attempt relationships.

### Tests for User Story 2

- [X] T027 [US2] Add queued cancel, running cancellation-requested, provider terminal after cancellation, late cancel stale, and unsupported cancel tests in tests/js/jobs_domain.test.js
- [X] T028 [US2] Add pause/resume supported, unsupported pause/resume, terminal pause/resume stale, and same-job-identity tests in tests/js/jobs_domain.test.js
- [X] T029 [US2] Add retryable failed/cancelled job, linked attempt, approved-continuation scope, widened-scope denial, and concurrent retry tests in tests/js/jobs_domain.test.js
- [X] T030 [P] [US2] Add inspector tests for cancellation-requested, paused, retryable terminal jobs, and linked attempts in tests/js/capability_inspector_render.test.js

### Implementation for User Story 2

- [X] T031 [US2] Implement `cancel` command for queued immediate cancellation, running cancellation-requested, unsupported-operation, stale terminal, and provider failure outcomes in static/capabilities/jobs.js
- [X] T032 [US2] Implement `pause` command with provider action checks, paused state, unsupported-operation, stale terminal, and safe reason outcomes in static/capabilities/jobs.js
- [X] T033 [US2] Implement `resume` command returning paused jobs to queued/running state with the same job identity in static/capabilities/jobs.js
- [X] T034 [US2] Implement `retry` command with terminal-state checks, retryability, one active retry attempt, linked attempts, approved-continuation scope, and retry-started outcomes in static/capabilities/jobs.js
- [X] T035 [US2] Implement approval scope matching for provider, job type, target, requester, and inputs in static/capabilities/jobs.js
- [X] T036 [US2] Emit `jobs:cancellation-requested`, `jobs:cancelled`, `jobs:paused`, `jobs:resumed`, and `jobs:retried` events in static/capabilities/jobs.js
- [X] T037 [US2] Update Capability Inspector jobs rendering for cancellation state, pause/resume actions, retry action, and attempt history in plugins/capability_inspector/screen.js

**Checkpoint**: User Story 2 is independently functional; all job control actions produce explicit outcomes and keep job state truthful.

---

## Phase 5: User Story 3 - Coordinate Job Providers And Scheduling (Priority: P3)

**Goal**: Providers can coexist with deterministic selection, capacity limits, priority ordering, reload recovery, and duplicate suppression.

**Independent Test**: Register multiple providers with different job types/capacity, enqueue compatible and incompatible jobs, simulate reload/recovery, and confirm scheduling and lifecycle events are deterministic.

### Tests for User Story 3

- [X] T038 [US3] Add exactly-one-provider auto-select, multiple-provider provider-selection-required, selected/default provider, unavailable selection, and explicit provider tests in tests/js/jobs_scheduling.test.js
- [X] T039 [US3] Add provider capacity, queued blocked reason, user-approved-before-background priority, FIFO within priority, and no overrun tests in tests/js/jobs_scheduling.test.js
- [X] T040 [US3] Add provider disappearance, provider-unavailable/orphaned state, provider rehydration no duplicates, and incompatible version tests in tests/js/jobs_scheduling.test.js
- [X] T041 [US3] Add reload recovery tests for persisted recoverable queued/running/paused job references, non-recoverable orphan/provider-unavailable jobs, stale persisted reference cleanup, and terminal preservation in tests/js/jobs_scheduling.test.js
- [X] T042 [P] [US3] Add selected/default provider persistence fallback tests in tests/js/jobs_scheduling.test.js

### Implementation for User Story 3

- [X] T043 [US3] Implement selected/default provider state, localStorage persistence with in-memory fallback, and provider-selection-required logic in static/capabilities/jobs.js
- [X] T044 [US3] Implement scheduler capacity checks, queued blocked reasons, user-approved-interactive priority before background-maintenance, and FIFO ordering within priority in static/capabilities/jobs.js
- [X] T045 [US3] Implement start-next scheduling after enqueue, completion, cancellation, provider availability change, and resume in static/capabilities/jobs.js
- [X] T046 [US3] Implement provider disappearance and incompatible-provider handling that marks affected jobs provider-unavailable or orphaned with safe reasons in static/capabilities/jobs.js
- [X] T047 [US3] Implement provider rehydration and recoverable job reconciliation without duplicating providers, active jobs, terminal jobs, or attempts in static/capabilities/jobs.js
- [X] T048 [US3] Implement reload recovery hooks that persist only redaction-safe provider-declared recoverable queued/running/paused job references, restore them on reload, clean stale references, and mark non-recoverable jobs orphan/provider-unavailable in static/capabilities/jobs.js
- [X] T049 [US3] Emit `jobs:provider-unavailable` and `jobs:orphaned` events and scheduling-related queued/started events in static/capabilities/jobs.js
- [X] T050 [US3] Update Capability Inspector jobs rendering for provider selection, capacity/current load, queued blocked reason, priority, and recovery status in plugins/capability_inspector/screen.js

**Checkpoint**: User Story 3 is independently functional; providers can be selected, scheduled, recovered, and diagnosed without duplicate queues or over-capacity starts.

---

## Phase 6: User Story 4 - Explain Privileged Job Failures Safely (Priority: P4)

**Goal**: Users and maintainers can troubleshoot job failures through bounded, redaction-safe diagnostics and compatibility bridge records.

**Independent Test**: Force each failure/terminal outcome, export or inspect diagnostics, and confirm provider, job type, state, operation, safe reason, retryability, bridge usage, and redaction rules are correct.

### Tests for User Story 4

- [X] T051 [US4] Add diagnostics schema, active/queued/paused/recent terminal grouping, all-active retention, five-terminal retention, and 50-entry history cap tests in tests/js/jobs_diagnostics.test.js
- [X] T052 [US4] Add redaction tests for paths, raw filenames, URLs, tokens, command lines, environment values, raw artifacts, media buffers, recordings, native handles, subprocess handles, and provider-private payloads in tests/js/jobs_diagnostics.test.js
- [X] T053 [US4] Add failure category tests for invalid-input, permission-denied, provider-unavailable, unsupported-operation, timeout, cancellation, external-dependency, storage, provider-failure, and unknown in tests/js/jobs_diagnostics.test.js
- [X] T054 [US4] Add compatibility bridge hit, legacy duplicate suppression, legacy queue/status/backend-route operations, and diagnostics-only bridge tests in tests/js/jobs_compat.test.js
- [X] T055 [P] [US4] Add inspector diagnostics tests for terminal jobs, safe failure category, bridge hits, retention limits, and redacted log messages in tests/js/capability_inspector_render.test.js

### Implementation for User Story 4

- [X] T056 [US4] Implement diagnostics payload `slopsmith.jobs.diagnostics.v1` with providers, selectedProviders, jobs, outcomes, bridgeHits, limits, and notes in static/capabilities/jobs.js
- [X] T057 [US4] Implement retention policy preserving all active jobs, at least five recent terminal jobs, and at most 50 progress/log entries per job within snapshot budget in static/capabilities/jobs.js
- [X] T058 [US4] Implement failure category normalization and safe retryability summaries for invalid input, permission denied, provider unavailable, unsupported operation, timeout, cancellation, external dependency, storage, provider failure, and unknown in static/capabilities/jobs.js
- [X] T059 [US4] Implement redaction/pseudonymization enforcement for exported diagnostics and local inspector snapshots in static/capabilities/jobs.js
- [X] T060 [US4] Implement `record-bridge-hit` command and bridge hit normalization for legacy plugin queue, status screen, backend route, progress poll, and update flow in static/capabilities/jobs.js
- [X] T061 [US4] Implement native-over-compatibility duplicate suppression for logical jobs shared by native providers and compatibility-backed legacy surfaces in static/capabilities/jobs.js
- [X] T062 [US4] Update Capability Inspector jobs rendering for recent terminal jobs, failure categories, retention notes, bridge hits, and redacted history in plugins/capability_inspector/screen.js

**Checkpoint**: User Story 4 is independently functional; support surfaces explain failures and migration bridges without leaking privileged data.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, migration guidance, validation, and cleanup across all stories.

- [X] T063 [P] Update jobs active-domain command/event/diagnostics guidance in docs/capability-domains.md
- [X] T064 [P] Update jobs migration status and removal gates in docs/capability-roadmap.md
- [X] T065 [P] Update jobs privileged provider-coordinator row and outcomes in docs/capability-safety-matrix.md
- [X] T066 [P] Add jobs provider/requester manifest and dispatch recipe in docs/capability-recipes.md
- [X] T067 [P] Add changelog entry for the jobs control plane in CHANGELOG.md
- [X] T068 Run syntax checks for static/capabilities.js, static/capabilities/jobs.js, and plugins/capability_inspector/screen.js
- [X] T069 Run focused JS validation with npm run test:js and confirm jobs tests pass in tests/js/jobs_domain.test.js, tests/js/jobs_scheduling.test.js, tests/js/jobs_diagnostics.test.js, tests/js/jobs_compat.test.js, and tests/js/capability_inspector_render.test.js
- [X] T070 Run focused pytest regression if diagnostics/plugin/redaction Python surfaces changed in tests/test_diagnostics_bundle.py, tests/test_diagnostics_redact.py, tests/test_plugins.py, and tests/test_plugin_runtime_idempotence.py
- [X] T071 Run browser console smoke after UI wiring with tests/browser/check-errors.spec.ts
- [X] T072 Verify quickstart scenarios and update any discovered validation notes in specs/009-jobs/quickstart.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; creates shell files and test harness scaffolding.
- **Foundational (Phase 2)**: Depends on Setup; blocks all user stories because each story needs active domain metadata, shared state, provider registry, and diagnostics skeleton.
- **User Stories (Phase 3+)**: Depend on Foundational. Stories are organized by priority and can be implemented incrementally.
- **Polish (Phase 7)**: Depends on all desired user stories for final documentation and validation.

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational; this is the MVP and has no dependency on other stories.
- **User Story 2 (P2)**: Can start after Foundational but depends on US1 job state and terminal outcome primitives for meaningful cancel/pause/resume/retry behavior.
- **User Story 3 (P3)**: Can start after Foundational and can run mostly in parallel with US2 after US1 establishes basic enqueue/list/inspect behavior.
- **User Story 4 (P4)**: Can start after Foundational but depends on state/outcome data produced by US1-US3 for complete diagnostics coverage.

### Within Each User Story

- Tests are listed before implementation and should be written first.
- Runtime tasks in static/capabilities/jobs.js should follow data-model order: providers, jobs, progress, outcomes, actions, scheduling, diagnostics.
- Inspector tasks should follow runtime snapshot shape for that story.
- Story checkpoint should pass before moving to the next priority.

### Parallel Opportunities

- T003-T005 can run in parallel after T001/T002 because they touch separate test files.
- T014 can run in parallel with static/capabilities/jobs.js foundational work once outcome names are known.
- Inspector tests for each story can run in parallel with runtime tests because they target tests/js/capability_inspector_render.test.js fixtures.
- US2 and US3 can run partly in parallel after US1 because they touch different tests and separate command areas, but both converge on static/capabilities/jobs.js.
- Documentation tasks T063-T067 can run in parallel after story behavior is stable.

---

## Parallel Example: User Story 1

```text
Task: T015 Add provider registration tests in tests/js/jobs_domain.test.js
Task: T018 Add Capability Inspector jobs rendering tests in tests/js/capability_inspector_render.test.js
```

After tests are in place, implement runtime work sequentially in static/capabilities/jobs.js because provider registration, enqueue, progress, and terminal state share the same state machine.

---

## Parallel Example: User Story 2

```text
Task: T027 Add cancellation tests in tests/js/jobs_domain.test.js
Task: T030 Add inspector action/attempt tests in tests/js/capability_inspector_render.test.js
```

Runtime cancel, pause, resume, retry, and approval-scope work should be sequenced in T031-T036 because each command depends on consistent job/action state.

---

## Parallel Example: User Story 3

```text
Task: T038 Add provider-selection tests in tests/js/jobs_scheduling.test.js
Task: T042 Add selected/default provider persistence tests in tests/js/jobs_scheduling.test.js
```

Runtime scheduling work should be sequenced in T043-T049 because selection, capacity, rehydration, and recovery all mutate provider/job state.

---

## Parallel Example: User Story 4

```text
Task: T051 Add diagnostics retention tests in tests/js/jobs_diagnostics.test.js
Task: T054 Add compatibility bridge tests in tests/js/jobs_compat.test.js
Task: T055 Add inspector diagnostics render tests in tests/js/capability_inspector_render.test.js
```

Runtime diagnostics work should be sequenced in T056-T061 because redaction, retention, failure categories, and bridges all feed one diagnostics snapshot.

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. Stop and validate provider registration, user-approved enqueue, progress, completion/failure, list, inspect, events, diagnostics, and inspector rendering.
5. Demo MVP as a single-provider jobs control plane.

### Incremental Delivery

1. Complete Setup + Foundational -> domain loads and empty diagnostics are available.
2. Add US1 -> track long-running work as jobs.
3. Add US2 -> user control actions and retries.
4. Add US3 -> multi-provider selection, scheduling, and reload recovery.
5. Add US4 -> safe failure explanation, retention, redaction, and compatibility bridges.
6. Finish Polish -> docs, changelog, validation, and quickstart.

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together.
2. Developer A owns US1 runtime and jobs_domain tests.
3. Developer B prepares US2 command tests once US1 state primitives land.
4. Developer C prepares US3 scheduling tests and provider-selection fixtures.
5. Developer D prepares US4 diagnostics/compatibility/inspector tests and docs.
6. Integrate through static/capabilities/jobs.js in priority order to avoid state-machine conflicts.

## Scope Boundaries

This task list intentionally excludes actual media import/export semantics, plugin install/update trust policy, external-service trust policy, recording capture, audio-effects processing, backend route privilege review, and moving plugin-owned work into core. Those workflows may report jobs, but their own data and trust contracts belong to future slices.

## Format Validation

- All executable tasks use `- [ ] T###` checklist format.
- Story-phase tasks include `[US1]`, `[US2]`, `[US3]`, or `[US4]` labels.
- Setup, Foundational, and Polish tasks intentionally omit story labels.
- `[P]` appears only on tasks that touch different files or separable documentation/test surfaces.
- Every task description includes at least one exact repository file path.
