// The window globals are a THIRD-PARTY CONTRACT. Pin them.
//
// Out-of-tree plugins load their screen.js as a CLASSIC script and call these
// as bare globals. Nothing in core reads most of them, so a call-graph scan,
// ESLint's no-undef, and a grep all come back clean while the plugin breaks in
// the field. This is the frontend twin of tests/test_plugin_context_contract.py
// — same reasoning, same literal-list rule.
//
// This guard is retroactive: `esc` was an implicit global back when app.js was
// a classic script, went module-scoped in a9fce29, and got carved into
// js/dom.js in 14b4058. The re-export list at the bottom of app.js was rebuilt
// without it, and the MIDI plugin's device list threw "esc is not defined" for
// testers — reported as "MIDI Access denied", because the ReferenceError landed
// in a try/catch meant for permission failures.
//
// WHY A LITERAL LIST AND NOT A DERIVED ONE. Deriving the expected set from
// app.js would assert the code equals itself. The point is that a human has to
// look at a diff and consciously agree to change the contract.

import { test, expect } from '@playwright/test';

const PLUGIN_GLOBALS = [
  '_confirmDialog', '_getArrangementNamingMode', '_libraryLocalFilename', '_librarySongArtUrl',
  '_librarySongId', '_onHeaderClick', '_onNamingModeChange', '_trapFocusInModal',
  'changeArrangement', 'checkPluginUpdates', 'clearLibFilters', 'clearLoop',
  'deleteSelectedLoop', 'esc', 'exportDiagnostics', 'exportSettings', 'filterFavorites',
  'filterLibrary', 'fullRescanLibrary', 'goFavPage', 'handleSliderInput',
  'hideScanBanner', 'importSettings', 'loadPlugins', 'loadSavedLoop',
  'loadSettings', 'onSectionPracticeModeChange', 'openEditModal', 'persistSetting',
  'pickDlcFolder', 'pinCurrentArrangementDefault', 'playSong', 'previewDiagnostics',
  'previewEditArt', 'renderGridCards', 'renderTreeInto', 'rescanLibrary',
  'retuneSong', 'saveCurrentLoop', 'saveSettings', 'seekBy',
  'setAvOffsetMs', 'setFavView', 'setInstrumentPathway', 'setLibView',
  'setLibraryProvider', 'setLoopEnd', 'setLoopStart', 'setMastery',
  'setSpeed', 'setViz', 'showScreen', 'sortFavorites',
  'sortLibrary', 'syncLibrarySong', 'toggleAllArtists', 'toggleAllFavoriteArtists',
  'toggleLibFilters', 'togglePlay', 'toggleSectionPracticePopover', 'uiPrompt',
  'updatePlugin', 'uploadSongs',
  'filterFavTreeLetter', 'filterTreeLetter', 'goFavTreePage', 'goTreePage',
];

test('plugin-facing window globals are all callable', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });

  const missing = await page.evaluate(
    (names) => names.filter((n) => typeof (window as any)[n] !== 'function'),
    PLUGIN_GLOBALS,
  );

  expect(missing, `window globals plugins depend on are missing or not functions: ${missing.join(', ')}`).toEqual([]);
});

// The plugin call site that actually broke: esc() interpolated into a template
// string. A global that exists but doesn't escape is its own bug.
test('window.esc escapes HTML metacharacters', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });

  const escaped = await page.evaluate(() => (window as any).esc('<img src=x onerror=alert(1)>'));
  expect(escaped).not.toContain('<img');
  expect(escaped).toContain('&lt;');
});
