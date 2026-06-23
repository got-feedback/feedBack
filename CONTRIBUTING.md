# Contributing to FeedBack

Thanks for wanting to contribute! This document covers the legal and workflow expectations for code, plugins, and documentation contributions.

## License

FeedBack is licensed under [AGPL-3.0-only](LICENSE). Contributions you submit (PRs, patches, documentation, plugin entries in the curated list) are licensed inbound under the same terms — **inbound = outbound**. By opening a pull request, you agree that your contribution may be distributed under AGPL-3.0-only as part of FeedBack.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) to track contribution provenance. Every commit must be signed off:

```bash
git commit -s -m "your commit message"
```

This appends a line to your commit message like:

```text
Signed-off-by: Jane Developer <jane@example.com>
```

The sign-off certifies that you wrote the code (or have the right to submit it) and that you're contributing it under AGPL-3.0-only as the LICENSE file describes. The full text of the certification is at [developercertificate.org](https://developercertificate.org/).

If you forget to sign off, amend the most recent commit with `git commit --amend -s` (or rebase + sign off older commits) and force-push to your PR branch.

## Plugin licensing

Plugins live in their own repositories and are loaded at runtime — see the [Plugin System section in CLAUDE.md](CLAUDE.md) for the technical contract, and [Plugin Best Practices](CLAUDE.md) for the conventions every plugin should follow (v2/v3 player chrome, the visualization contracts, and the **performance rules** — no per-frame DOM queries or broad `document.body` `MutationObserver`s — that keep the 60 fps highway smooth). Plugins are not subject to AGPL by being loaded into FeedBack (the loader runs them as separate Python modules / browser scripts), but for the **curated plugin list** to accept your plugin we ask that it be released under an AGPL-3.0-compatible license:

- AGPL-3.0-only or AGPL-3.0-or-later
- GPL-3.0-only or GPL-3.0-or-later
- LGPL-3.0-only or LGPL-3.0-or-later
- MIT
- BSD-2-Clause or BSD-3-Clause
- Apache-2.0
- ISC
- Unlicense / CC0-1.0 / 0BSD

Plugins under GPL-2.0-only, LGPL-2.1-only, CDDL, EPL, or proprietary terms will not be added to the curated list. You're still free to publish and self-distribute them — FeedBack will load any plugin a user installs locally — but they won't be promoted from the main project.

## Workflow

Standard PR workflow described in [CLAUDE.md → Git Workflow](CLAUDE.md):
- Never push directly to `main`.
- Create a feature branch on your fork.
- Open a PR against `got-feedback/feedBack:main`.
- Keep commits scoped and well-described; short imperative subject + `Signed-off-by` trailer.

## Questions

Open an issue or start a [Discussion](https://github.com/got-feedback/feedBack/discussions) if you're unsure whether a contribution fits — much better to ask early than to find out after the work is done.
