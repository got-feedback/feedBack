// Flat ESLint config — MAINTAINER / CI ONLY. Never runs on the serve or Docker
// path (constitution Principle I: dev-only tooling is exempt, same category as
// scripts/build-tailwind.sh). It enforces the module-migration guardrails:
//
//   * max-lines — the 1,500-line size norm, as a WARNING ratchet. Legacy
//     monoliths warn (the "this is over the norm, split it" signal) and shrink
//     as the refactor lands; warnings do not fail CI. Genuinely-large files are
//     exempted below, mirroring the signed register in docs/size-exemptions.md.
//   * import-x/no-unresolved + no-cycle — module hygiene, scoped to the real
//     ES-module graphs the refactor produces (a plugin's src/ tree, .mjs
//     tests). no-unresolved (a HARD error) catches broken import paths;
//     no-cycle enforces the downward-only layering rule. Core's classic scripts
//     have no import graph, so both are dormant today and become live gates the
//     moment module code appears — validated against the first real module
//     plugin (R1 pilot).

const importX = require('eslint-plugin-import-x');

// Per-file size ceilings — a mirror of docs/size-exemptions.md (canonical).
// Keep in sync; each entry corresponds to a signed row in the register.
const SIZE_EXEMPTIONS = [
    { files: ['**/static/capabilities.js'], max: 1600 },
    { files: ['**/plugins/capability_inspector/screen.js'], max: 100000 },
    { files: ['**/plugins/folder_library/screen.js'], max: 100000 },
];

const sizeRule = (max) => ['warn', { max, skipBlankLines: false, skipComments: false }];

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'static/vendor/**',
            'plugins/**/assets/vendor/**',
            '**/*.min.js',
            'static/tailwind.min.css',
        ],
    },
    // Size norm across all first-party JS. Classic scripts are parsed as
    // scripts (no import/export); module files get their own block below.
    {
        files: ['**/*.js', '**/*.cjs'],
        languageOptions: { ecmaVersion: 'latest', sourceType: 'script' },
        rules: { 'max-lines': sizeRule(1500) },
    },
    // ES-module graphs (a plugin's src/ tree, .mjs tests): module parsing + the
    // acyclic-imports hard gate + the size norm. A migrated bundled plugin's
    // entry `import './src/main.js'` screen.js must parse as a module — add its
    // glob here in that plugin's migration PR (classic screen.js stays a script).
    {
        files: ['**/src/**/*.js', '**/*.mjs'],
        languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        plugins: { 'import-x': importX },
        // v4 flat-config resolver (resolver-next + createNodeResolver). Without
        // it the import rules silently skip imports they can't resolve.
        settings: { 'import-x/resolver-next': [importX.createNodeResolver()] },
        rules: {
            'max-lines': sizeRule(1500),
            'import-x/no-unresolved': 'error',
            'import-x/no-cycle': 'error',
        },
    },
    // Signed size exemptions (docs/size-exemptions.md) — raise the ceiling so
    // registered files don't warn below it.
    ...SIZE_EXEMPTIONS.map(({ files, max }) => ({ files, rules: { 'max-lines': sizeRule(max) } })),
];
