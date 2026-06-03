<!--
Thanks for the PR! A few quick reminders before you hit submit:
- DCO sign-off on every commit (git commit -s; --amend -s to fix)
- Plugin work? Check docs/PLUGIN_AUTHORING.md and validate plugin.json
  against schema/plugin.schema.json, including capability metadata
- Touching the highway / player UI? Add or update a Playwright test
  under tests/browser/
-->

## Summary

<!-- 1–3 bullets describing what changes and why. Link related discussion. -->

## Linked issue

<!-- Closes #1234, or "n/a" if this is a chore/docs change -->

## Test plan

<!-- How did you verify? Tick what applies. -->

- [ ] `pytest -q` passes locally
- [ ] `npm run test:js` passes locally
- [ ] `npm test` (Playwright) passes locally — *or* CI will run it
- [ ] Verified in `docker compose up` (live-reload working directory)
- [ ] Plugin manifest validates against `schema/plugin.schema.json` (legacy fields + capability metadata)
- [ ] Not applicable — explain below

## Screenshots / recordings

<!-- For UI changes, paste before/after. Drag-drop into the editor or use a GIF. -->

## Checklist

- [ ] DCO sign-off on every commit (`Signed-off-by:` trailer)
- [ ] Conventional-commit subject (`feat(scope):`, `fix(scope):`, `docs:`, `chore:`)
- [ ] `CHANGELOG.md` `[Unreleased]` section updated (skip for chore/docs)
- [ ] Documentation updated if behaviour or contracts changed
