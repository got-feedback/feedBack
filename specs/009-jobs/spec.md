# Feature Specification: Jobs Control Plane

**Feature Branch**: `009-jobs`  
**Created**: 2026-05-31  
**Status**: Draft  
**Input**: User description: "Continue with the next slice: jobs"

## Clarifications

### Session 2026-05-31

- Q: How should queued, running, or paused jobs behave after app reload? → A: Restore only jobs with provider-declared recovery support; mark others orphaned or provider-unavailable with a safe reason.
- Q: How should jobs choose a provider when multiple compatible providers can handle the same job type? → A: Auto-select only one compatible provider; otherwise require a selected/default provider and return provider-selection-required.
- Q: What scope should explicit user approval cover for privileged jobs and continuations? → A: One job request plus provider-declared retry/continuation attempts for the same provider, job type, target, and requester.
- Q: How should queued jobs be ordered when user-approved and background jobs compete for provider capacity? → A: Run user-approved interactive jobs before background or maintenance jobs; use FIFO within each priority and provider capacity.
- Q: How much job history and log detail should diagnostics retain? → A: Preserve all active jobs, at least 5 recent terminal jobs, and cap per-job logs/progress at 50 entries or the support snapshot budget.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Track Long-Running Work (Priority: P1)

A user can see conversion, import, update, preview, and studio work as jobs with clear queued, running, completed, cancelled, failed, or unavailable state instead of hunting through plugin-specific screens or vague progress messages.

**Why this priority**: The jobs slice is only useful if users and support tooling can answer the basic questions: what is running, who started it, how far along it is, and whether it finished successfully.

**Independent Test**: Can be tested by registering a representative job provider, enqueueing a long-running job, reporting progress, completing it, and confirming the job list, job inspection view, events, and diagnostics describe the same state.

**Acceptance Scenarios**:

1. **Given** an available job provider, **When** a user starts a supported long-running task, **Then** the system creates a job with provider attribution, requester attribution, job type, status, progress summary, and safe display label.
2. **Given** a job is queued or running, **When** the user inspects jobs, **Then** the job appears with current state, step summary, elapsed time, and next expected transition when known.
3. **Given** a job reports determinate progress, **When** progress changes, **Then** the system records the latest percentage and step summary without duplicating the job.
4. **Given** a job reports indeterminate progress, **When** progress changes, **Then** the system shows that work is active without inventing an inaccurate percentage.
5. **Given** a job completes successfully, **When** the user inspects jobs, **Then** the job shows a terminal completed state, completion time, safe result summary, and no active work indicators.
6. **Given** no provider can handle a requested job type, **When** a user attempts to enqueue it, **Then** the system returns a clear unavailable or no-owner outcome without creating an orphan running job.

---

### User Story 2 - Cancel, Pause, Resume, And Retry Jobs (Priority: P2)

A user can stop unwanted work, temporarily pause resumable work, resume paused work, and retry failed or cancelled work when the provider supports those actions.

**Why this priority**: Long-running privileged work needs user control. Without predictable cancellation and retry behavior, conversion or update failures leave users unsure whether data is still changing or whether they need to start over.

**Independent Test**: Can be tested by running jobs that support cancellation, pause, resume, and retry, then forcing unsupported or late requests and verifying each request reaches an unambiguous outcome.

**Acceptance Scenarios**:

1. **Given** a queued job, **When** the user cancels it before it starts, **Then** the job reaches cancelled state and the provider does not start the underlying work.
2. **Given** a running cancellable job, **When** the user cancels it, **Then** the system records cancellation requested and later records cancelled, failed, or completed according to the provider's final report.
3. **Given** a running job that supports pause, **When** the user pauses it, **Then** the job enters paused state and preserves enough state for the provider to resume it.
4. **Given** a paused job, **When** the user resumes it, **Then** the job returns to queued or running state with the same job identity.
5. **Given** a failed or cancelled retryable job, **When** the user retries it, **Then** the system creates a retry attempt linked to the prior job and shows both the current attempt and previous terminal outcome.
6. **Given** a provider does not support pause, resume, cancel, or retry for a job, **When** that action is requested, **Then** the system reports unsupported without changing the job to an inaccurate state.

---

### User Story 3 - Coordinate Job Providers And Scheduling (Priority: P3)

A plugin author can register job capabilities through one shared jobs contract so conversion, import, update, preview, and studio providers can coexist without duplicate queues or conflicting capacity rules.

**Why this priority**: Several plugins perform long-running work today. A shared provider model prevents each plugin from inventing its own queue, progress, cancellation, and failure vocabulary.

**Independent Test**: Can be tested by registering multiple providers with different job types and concurrency limits, enqueueing compatible and incompatible jobs, and confirming scheduling, provider selection, duplicate suppression, and lifecycle events are deterministic.

**Acceptance Scenarios**:

1. **Given** a provider registers supported job types and capacity, **When** jobs are inspected, **Then** the provider appears with availability, supported actions, current load, and safe status.
2. **Given** multiple providers support the same job type, **When** no user-selected or default provider exists, **Then** the system returns provider-selection-required instead of choosing arbitrarily.
3. **Given** a provider declares limited concurrent capacity, **When** additional jobs are enqueued, **Then** user-approved interactive jobs run before background or maintenance jobs, and excess jobs remain queued FIFO within each priority with a clear reason until capacity is available.
4. **Given** a provider rehydrates or registers repeatedly, **When** jobs are inspected, **Then** the provider and its active jobs are not duplicated.
5. **Given** a provider disappears while jobs are queued or running, **When** jobs are inspected, **Then** affected jobs become provider-unavailable, orphaned, failed, or waiting with a safe reason rather than remaining silently active.
6. **Given** a requester submits malformed, incompatible, or unsupported job parameters, **When** enqueue is attempted, **Then** the system rejects the request with a distinct outcome and no running work begins.

---

### User Story 4 - Explain Privileged Job Failures Safely (Priority: P4)

A user or maintainer troubleshooting long-running work can tell whether a job failed because of provider unavailability, invalid input, missing permission, cancellation, timeout, external dependency failure, storage limits, unsupported operation, or a provider error without exposing private paths, secrets, or raw job artifacts.

**Why this priority**: Jobs often touch files, downloads, subprocesses, conversion tools, and plugin-owned state. Troubleshooting needs precise outcomes, but support bundles must not leak local libraries or privileged payloads.

**Independent Test**: Can be tested by forcing each terminal and failure outcome, exporting diagnostics, and confirming the job history identifies provider, job type, state, operation, bounded safe reason, and redacted artifacts.

**Acceptance Scenarios**:

1. **Given** a job fails, **When** diagnostics are inspected, **Then** the failure includes provider attribution, job type, operation, terminal outcome, safe reason, and retryability without raw paths or secrets.
2. **Given** a job produces logs, **When** diagnostics are exported, **Then** logs are bounded, redacted, and tied to job identity without exposing raw command lines, local paths, tokens, or unreviewed artifacts.
3. **Given** a job uses external services or subprocess-backed work, **When** the job changes state, **Then** the system records safe dependency status and user-visible failure category without leaking privileged invocation details.
4. **Given** several completed or failed jobs exist, **When** diagnostics are exported, **Then** all active jobs and at least the five most recent terminal jobs are preserved, while per-job logs and progress entries are capped at 50 entries or the support snapshot budget.

### Edge Cases

- A job provider is unavailable, disabled, not hydrated, or incompatible when a job is enqueued.
- A provider supports status inspection but not cancellation, pause, resume, or retry.
- A user cancels a job at the same time it completes or fails.
- A cancellation request is accepted but the provider cannot stop immediately.
- A queued job is cancelled before it starts.
- User-approved interactive jobs and background or maintenance jobs compete for the same provider capacity.
- A running job becomes orphaned because its provider disappears, reloads, or changes contract version.
- Multiple providers support the same job type and no default or explicit provider is available.
- A provider registers the same logical job or provider identity repeatedly during script hydration.
- A provider reports progress out of order, decreases determinate progress unexpectedly, reports progress after a terminal state, or reports completion without a prior running event.
- A job reports indeterminate progress or unknown total work.
- A job has child steps, attempts, or retries that must stay linked to the user-visible parent job.
- A retry is requested for a non-retryable job or while another retry attempt is already active.
- A pause or resume request is made after the job is already terminal.
- A job request would overwrite, delete, download, convert, or export user files without explicit user approval for the same provider, job type, target, and requester.
- A job depends on unavailable storage, external services, subprocess tools, native bridges, or plugin-owned resources.
- A provider returns sensitive labels, local paths, raw command lines, secret-bearing URLs, tokens, raw artifacts, or overly large logs.
- Diagnostics are requested while jobs are active, while providers are hydrating, or after many terminal jobs have accumulated.
- A user reloads the app while jobs are queued, running, paused, or terminal; only jobs with provider-declared recovery support are restored, while other non-terminal jobs become orphaned or provider-unavailable with a safe reason.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide an authoritative jobs control plane for registering job providers, enqueueing jobs, listing jobs, inspecting a job, cancelling jobs, pausing jobs, resuming jobs, and retrying jobs where supported.
- **FR-002**: System MUST represent each job provider with provider attribution, supported job types, supported actions, availability, capacity summary, current load, and bounded safe reason when unavailable or degraded.
- **FR-003**: System MUST represent each job with stable job identity, provider attribution, requester attribution, job type, priority or scheduling class, current state, progress summary, timestamps, safe display label, and terminal outcome when applicable.
- **FR-004**: System MUST support job states including queued, running, paused, cancellation-requested, cancelled, completed, failed, provider-unavailable, and orphaned.
- **FR-005**: System MUST expose explicit outcomes including handled, queued, denied, user-action-required, unavailable, no-owner, no-handler, no-target, unsupported-command, unsupported-operation, incompatible, incompatible-version, provider-selection-required, validation-failed, stale, cancelled, completed, failed, timeout, and retry-started.
- **FR-006**: System MUST allow users and authorized requesters to inspect current jobs and providers without triggering privileged work, file writes, downloads, subprocesses, or external-service calls.
- **FR-007**: System MUST require explicit user action before enqueueing any job that can create, modify, delete, download, export, convert, or publish user-visible files or plugin state; approval applies only to one job request and provider-declared retry or continuation attempts for the same provider, job type, target, requester, and inputs.
- **FR-008**: System MUST reject background or plugin-initiated privileged jobs without user approval using a distinct denied or user-action-required outcome, including approved-continuation attempts whose inputs do not match the original approved scope.
- **FR-009**: System MUST apply provider-declared scheduling limits so queued jobs do not exceed provider capacity and running jobs do not silently overrun declared concurrency; user-approved interactive jobs MUST run before background or maintenance jobs, with FIFO ordering within each priority.
- **FR-010**: System MUST make provider registration idempotent so repeated hydration updates provider state without duplicate providers or duplicated active jobs.
- **FR-011**: System MUST auto-select only when exactly one compatible provider can handle the job type; when multiple compatible providers exist, the system MUST use a user-selected/default provider or return provider-selection-required.
- **FR-012**: System MUST validate job requests before they begin and report validation failures without starting provider work.
- **FR-013**: System MUST emit observable lifecycle events when jobs are queued, started, progress, log, pause, resume, cancellation-requested, cancelled, completed, failed, retried, orphaned, or provider-unavailable.
- **FR-014**: System MUST allow determinate progress, indeterminate progress, current-step summaries, and bounded safe messages without requiring providers to expose raw job internals.
- **FR-015**: System MUST ignore or flag stale provider updates that arrive after a job reaches a terminal state or after a newer retry attempt supersedes the prior attempt.
- **FR-016**: System MUST treat cancellation as a request for running work and MUST preserve a distinct cancellation-requested state until the provider reports the terminal result.
- **FR-017**: System MUST cancel queued jobs immediately when requested and prevent them from starting later.
- **FR-018**: System MUST report unsupported pause, resume, cancel, or retry actions without changing job state inaccurately.
- **FR-019**: System MUST support retry only for terminal jobs that the provider marks retryable or that the system can safely re-enqueue with the same approved provider, job type, target, requester, and inputs.
- **FR-020**: System MUST link retry attempts to their original job so users and diagnostics can see attempt history and current active attempt.
- **FR-021**: System MUST handle provider disappearance, disablement, timeout, or incompatible version by marking affected jobs provider-unavailable, orphaned, failed, or waiting with a safe reason.
- **FR-022**: System MUST distinguish invalid input, permission denied, provider unavailable, unsupported operation, timeout, cancellation, external dependency failure, storage failure, and provider failure in job outcomes.
- **FR-023**: System MUST preserve existing plugin-specific job queues and status screens during migration by recording compatibility bridge hits where feasible.
- **FR-024**: System MUST prevent duplicate user-visible jobs when native job providers and compatibility-backed legacy surfaces describe the same logical job.
- **FR-025**: System MUST include providers, active jobs, queued jobs, paused jobs, recent terminal jobs, retry attempts, bridge hits, recent outcomes, and bounded safe logs in diagnostics.
- **FR-026**: System MUST redact or pseudonymize local paths, raw filenames when sensitive, secret-bearing URLs, tokens, command lines, environment values, raw artifacts, plugin-private payloads, and user library details in support surfaces and diagnostics.
- **FR-027**: System MUST NOT expose raw media files, converted artifacts, audio buffers, recordings, downloaded payloads, subprocess handles, native handles, or plugin-private objects through job state or diagnostics.
- **FR-028**: System MUST bound retained job history, progress messages, and logs so support snapshots remain small while preserving all active jobs, at least the five most recent terminal jobs, and no more than 50 progress or log entries per job unless the support snapshot budget requires stricter trimming.
- **FR-029**: System MUST give support tooling enough safe metadata to distinguish conversion, import, update, preview, studio, and compatibility-backed job paths.
- **FR-030**: System MUST document the migration path for job provider and requester plugins, including provider registration, enqueue behavior, progress reporting, cancellation, retry, diagnostics, legacy bridge behavior, and removal gates.
- **FR-031**: System MUST leave media import/export semantics, plugin installation policy, external-service trust policy, actual conversion algorithms, recording capture, audio-effects processing, and backend route privilege review outside this feature except for the job state and outcome summaries they report.
- **FR-032**: System MUST keep app reload behavior explicit: queued, running, and paused jobs MUST be restored only when the provider declares recovery support for that job; all other non-terminal jobs MUST be marked orphaned or provider-unavailable with a safe reason rather than silently assumed running.

### Key Entities

- **Job Provider**: A participant that can accept one or more long-running job types and report availability, capacity, supported actions, progress, and terminal outcomes.
- **Job Requester**: A user action, plugin, or app workflow that asks for long-running work and is attributed in job state and outcomes.
- **Job Approval Scope**: The exact provider, job type, target, requester, and inputs covered by one explicit user approval, including provider-declared retry or continuation attempts that do not widen that scope.
- **Job**: A user-visible unit of long-running work with identity, type, provider, requester, state, progress, timestamps, safe label, scheduling priority, and terminal outcome.
- **Job Type**: A category of work such as conversion, import, update, preview generation, studio processing, or compatibility-backed work.
- **Selected Job Provider**: The user-selected or default provider used when multiple compatible providers can handle the same job type.
- **Scheduling Policy**: Provider-declared and coordinator-enforced limits for queued and running work, including capacity, user-approved-interactive-before-background priority, FIFO ordering within each priority, and provider selection behavior.
- **Progress Snapshot**: The latest safe summary of determinate or indeterminate progress, current step, bounded message, and time information.
- **Job Action**: A user or requester operation such as enqueue, cancel, pause, resume, retry, list, or inspect.
- **Job Attempt**: A specific run of a job, including retry attempts linked to an original job.
- **Job Recovery Support**: Provider-declared metadata describing whether a queued, running, or paused job can be restored after app reload and what safe state should be shown if it cannot.
- **Terminal Outcome**: The final state and safe reason for completed, cancelled, failed, unavailable, timeout, or orphaned work.
- **Job Diagnostic Log Entry**: A bounded and redacted status or log message associated with a provider, job, attempt, and step, capped with progress history at 50 entries per job or the support snapshot budget.
- **Compatibility Bridge Hit**: A record that a legacy plugin queue, status surface, or job-like backend route was used during migration.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of registered job providers appear with provider attribution, supported job types, availability, capacity, and redaction-safe status in jobs diagnostics.
- **SC-002**: 100% of queued, running, paused, cancellation-requested, cancelled, completed, failed, provider-unavailable, and orphaned states are distinguishable in focused validation scenarios.
- **SC-003**: 100% of the canonical job outcomes listed in FR-005 produce distinct results in focused validation scenarios.
- **SC-004**: A user can determine what job is running, who owns it, what step it is on, and whether it can be cancelled or retried in one inspection step in 100% of tested cases.
- **SC-005**: Determinate progress updates are reflected in the job view and diagnostics within 1 second in focused validation scenarios.
- **SC-006**: Queued jobs cancelled before start never begin provider work in 100% of focused validation scenarios.
- **SC-007**: Running cancellable jobs enter cancellation-requested within 1 second and reach a terminal state reported by the provider in 100% of focused validation scenarios.
- **SC-008**: Provider concurrency limits are honored in 100% of scheduling validation scenarios; user-approved interactive jobs run before background or maintenance jobs, and excess jobs remain queued FIFO within each priority until capacity is available.
- **SC-009**: Rehydrating a provider five times in one session creates one provider record and no duplicate active jobs for each logical provider/job pair.
- **SC-010**: Native and compatibility-backed representations of the same logical job never create duplicate user-visible jobs in representative migration scenarios.
- **SC-011**: 100% of exported job diagnostics contain zero unredacted local paths, secret-bearing URLs, tokens, raw command lines, environment values, raw artifacts, media buffers, recordings, subprocess handles, native handles, or plugin-private objects.
- **SC-012**: Support maintainers can identify provider, job type, current state, last safe progress, retryability, and failure category for a representative failed job in under 5 minutes using diagnostics or the inspector.
- **SC-013**: Privileged job enqueue requests without explicit user approval are denied before work begins in 100% of focused validation scenarios.
- **SC-014**: After app reload, queued/running/paused jobs are restored, resumed, orphaned, or marked unavailable according to provider-declared recovery support in 100% of focused validation scenarios.
- **SC-015**: Retained job diagnostics stay within the support snapshot budget while preserving all active jobs, at least the five most recent terminal jobs, and no more than 50 progress or log entries per job in focused validation scenarios.

## Assumptions

- Slopsmith remains a self-hosted, single-user app, but multiple plugins or workflows may submit job requests during one session.
- The jobs control plane coordinates state, scheduling, progress, actions, and diagnostics; providers still own the actual conversion, import, update, preview, or studio work.
- Jobs are privileged because they may touch files, downloads, subprocesses, external services, native bridges, or plugin-owned state.
- Listing and inspecting jobs are safe, prompt-free operations; starting privileged work requires an explicit user-approved workflow whose approval scope does not widen across providers, job types, targets, requesters, or inputs.
- Existing plugin-specific queues, status views, and backend routes may coexist during migration.
- Some jobs can survive app reload or provider rehydration, while others must become unavailable or orphaned; providers declare recovery support.
- Progress may be determinate, indeterminate, or step-only depending on the provider.
- Media import/export contracts, plugin install/update policy, external-service trust decisions, and recording/audio processing algorithms will be specified by their own future slices and referenced by jobs only through safe job type, progress, and outcome summaries.
