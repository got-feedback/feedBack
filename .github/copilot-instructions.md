# GitHub Copilot instructions

This file customizes GitHub Copilot Chat and Copilot inline suggestions for the Slopsmith repository.

## Read first

- [`AGENTS.md`](../AGENTS.md) — canonical project orientation (architecture, conventions, first-hour pitfalls, verification). This file is a thin pointer; the real content lives there.
- [`docs/PLUGIN_AUTHORING.md`](../docs/PLUGIN_AUTHORING.md) — plugin work entry point

## House rules

- **License: AGPL-3.0-only.** Inbound contributions are AGPL-compatible. Do not suggest code copied verbatim from incompatible sources.
- **DCO sign-off required** on every commit (`git commit -s`).
- **No frontend frameworks.** Vanilla JS, Canvas, Tailwind classes. Do not suggest React/Vue/Svelte additions.
- **Plugin backend logging.** Suggest `context["log"]`, never `print()`.
- **Plugin Python imports.** For cross-file backend plugins, suggest `context["load_sibling"]("module_name")` instead of bare `from module_name import X`.
- **Capability metadata.** For new plugin integrations, suggest `standards: ["capability-pipelines.v1"]` and redaction-safe `capabilities` / `ui` metadata instead of legacy globals alone.
- **DCO/license headers.** When creating a new file in the main repo, no license header is needed (the LICENSE file at root governs). Plugin authors should add an SPDX-License-Identifier comment to their plugin's source files; the `license` field in `plugin.json` must match the allowlist in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Validation

When suggesting changes to a `plugin.json`, validate against [`schema/plugin.schema.json`](../schema/plugin.schema.json). The schema accepts current legacy fields and native `capability-pipelines.v1` metadata.
