# CLAUDE.md

Claude Code memory file. This repo's canonical project orientation lives in [`AGENTS.md`](AGENTS.md) - the cross-tool standard read by Cursor, Copilot, Codex, Aider, Cline, and others. The line below uses Claude Code's `@`-import to inline AGENTS.md into this memory file, so there's a single source of truth and no drift between two near-duplicate files.

@AGENTS.md

## Claude-specific surfaces

The rest of this file is content that *only* makes sense for Claude Code (other AI tools have their own incompatible automation mechanisms). Skills, subagent, rule, and settings live under [`.claude/`](.claude/):

- [`.claude/skills/plugin-scaffold/`](.claude/skills/plugin-scaffold/SKILL.md) - generates a new plugin skeleton (visualization / overlay / settings-only / routes-only).
- [`.claude/skills/plugin-validate/`](.claude/skills/plugin-validate/SKILL.md) - validates `plugin.json` against `schema/plugin.schema.json` locally before push.
- [`.claude/skills/speckit-*/`](.claude/skills/) - spec-kit skills (auto-generated from `.specify/`; don't edit manually).
- [`.claude/rules/plugin-author.md`](.claude/rules/plugin-author.md) - glob-scoped to `plugins/**`; encodes the contracts from `docs/PLUGIN_AUTHORING.md` so suggestions don't drift from them.
- [`.claude/agents/slopsmith-reviewer.md`](.claude/agents/slopsmith-reviewer.md) - plugin-aware code-review subagent. Invoke with `@slopsmith-reviewer`.
- [`.claude/settings.json`](.claude/settings.json) - repo defaults (no hooks enabled by default; commented opt-in example for `plugin.json` validation on save).

See [`.claude/README.md`](.claude/README.md) for conventions when adding more.

## Why this file is short

Everything you'd expect to find here - architecture, running the app, testing, conventions, plugin authoring, first-hour pitfalls - is imported above via `@AGENTS.md`. Updates go in `AGENTS.md`. This file only carries Claude-Code-specific automation references.
