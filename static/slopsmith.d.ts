/**
 * Slopsmith core — ambient plugin-contract declarations.
 *
 * This file is the typed source of truth for the plugin-facing JS surface:
 * `window.slopsmith`, `window.highway`, the highway WebSocket message shape,
 * and the `setRenderer` visualization contract. It is loaded into the `tsc`
 * program (see `tsconfig.json` `include`) as ambient types — core files that
 * carry `// @ts-check` pick these globals up without any `import`.
 *
 * Per the Constitution (Principle IV) these contracts are stable: a breaking
 * change here requires a CHANGELOG entry under "Migration notes".
 *
 * Hand-maintained — keep in sync with the live source. The runtime files
 * (`static/diagnostics.js`, `audio-mixer.js`, `tour-engine.js`,
 * `lottie-api.js`) are declared here but not themselves `@ts-check`'d yet.
 */

// ─── Chart data wire shapes ─────────────────────────────────────────────────

/** A single fretted note as streamed over the highway WebSocket. */
interface SlopsmithNote {
    /** Time, seconds. */
    t: number;
    /** String index (0 = lowest). */
    s: number;
    /** Fret number (0 = open). */
    f: number;
    /** Sustain length, seconds. */
    sus?: number;
    /** Hammer-on flag. */
    ho?: number;
    /** Pull-off flag. */
    po?: number;
    /** Slide-to fret. */
    sl?: number;
    /** Bend flag / amount. */
    bn?: number;
    [key: string]: unknown;
}

/** A chord event: a cluster of notes sharing a time. */
interface SlopsmithChord {
    /** Time, seconds. */
    t: number;
    /** Component notes (string/fret/sustain, no own `t`). */
    notes: Array<Omit<SlopsmithNote, 't'> & { t?: number }>;
    /** Index into the chord-templates table. */
    id?: number;
    [key: string]: unknown;
}

interface SlopsmithBeat { time: number; measure: number; }
interface SlopsmithSection { time: number; name: string; }
interface SlopsmithAnchor { time: number; fret: number; width: number; }
interface SlopsmithChordTemplate { name: string; frets: number[]; fingers?: number[]; }
interface SlopsmithLyric { w: string; t: number; d: number; }
interface SlopsmithToneChange { time: number; name: string; }

/** Per-note scoring judgment published via `highway.setNoteStateProvider`. */
interface SlopsmithNoteState {
    state: 'hit' | 'active' | 'miss';
    alpha: number;
    color: string | null;
}

/** A scorer callback: returns a judgment for a chart note, or nullish. */
type SlopsmithNoteStateProvider = (
    note: SlopsmithNote,
    chartTime: number,
) => SlopsmithNoteState | 'hit' | 'active' | 'miss' | null | undefined;

// ─── Highway WebSocket protocol ─────────────────────────────────────────────

/** `song_info` — song metadata frame. */
interface SlopsmithSongInfo {
    type: 'song_info';
    title: string;
    artist: string;
    arrangement: string;
    arrangement_index: number;
    arrangements: Array<{ name: string; index: number }>;
    duration: number;
    /** Tuning offsets — length 6 for guitar, 4 for bass. */
    tuning: number[];
    capo: number;
    format: 'psarc' | 'sloppak' | 'loose' | string;
    /** `null` when audio is unavailable. */
    audio_url: string | null;
    /** Non-null only when `audio_url` is null. */
    audio_error: string | null;
    /** Always present; empty array when there are no split stems. */
    stems: string[];
    /** Chart `<offset>`, seconds. Absent for sources without one. */
    offset?: number;
    /** Active-arrangement string count, when the server emits it. */
    stringCount?: number;
    [key: string]: unknown;
}

/**
 * A frame streamed over `/ws/highway/{filename}`. Discriminated on `type`;
 * the case set is the `switch (msg.type)` in `highway.js`.
 */
type SlopsmithHighwayMessage =
    | { type: 'loading'; stage: string }
    | SlopsmithSongInfo
    | { type: 'beats'; data: SlopsmithBeat[] }
    | { type: 'sections'; data: SlopsmithSection[] }
    | { type: 'anchors'; data: SlopsmithAnchor[] }
    | { type: 'chord_templates'; data: SlopsmithChordTemplate[] }
    | { type: 'lyrics'; data: SlopsmithLyric[] }
    | { type: 'tone_changes'; base: string; data: SlopsmithToneChange[] }
    | { type: 'notes'; data: SlopsmithNote[] }
    | { type: 'chords'; data: SlopsmithChord[] }
    | { type: 'handshapes'; data: unknown[] }
    | { type: 'phrases'; data: unknown[]; total: number }
    | { type: 'ready' };

// ─── Visualization renderer (setRenderer) contract ──────────────────────────

/**
 * Per-frame snapshot handed to a renderer's `draw()` / `init()`. All chart
 * arrays are difficulty-filter-aware.
 */
interface SlopsmithRenderBundle {
    currentTime: number;
    songInfo: SlopsmithSongInfo | Record<string, never>;
    isReady: boolean;
    notes: SlopsmithNote[];
    chords: SlopsmithChord[];
    anchors: SlopsmithAnchor[];
    beats: SlopsmithBeat[];
    sections: SlopsmithSection[];
    chordTemplates: SlopsmithChordTemplate[];
    stringCount: number;
    lyrics: SlopsmithLyric[];
    toneChanges: SlopsmithToneChange[];
    toneBase: string;
    mastery: number;
    hasPhraseData: boolean;
    inverted: boolean;
    lefty: boolean;
    renderScale: number;
    lyricsVisible: boolean;
    /** 2D-highway depth projection for a time offset. */
    project: (tOffset: number) => { x: number; y: number; scale: number };
    /** 2D-highway horizontal fret position. */
    fretX: (fret: number, scale: number, w: number) => number;
    /** Per-note scoring state, or null when no provider is registered. */
    getNoteState: (note: SlopsmithNote, chartTime: number) => SlopsmithNoteState | null;
}

/**
 * A renderer instance returned by a `window.slopsmithViz_<id>` factory.
 * Subject to multiple `init() … destroy()` cycles on one instance.
 */
interface SlopsmithRenderer {
    /** Required canvas context type; defaults to `'2d'` when omitted. */
    contextType?: '2d' | 'webgl2';
    init(canvas: HTMLCanvasElement, bundle: SlopsmithRenderBundle): void;
    draw(bundle: SlopsmithRenderBundle): void;
    resize?(w: number, h: number): void;
    destroy?(): void;
}

/** A `window.slopsmithViz_<id>` factory: fresh renderer per call. */
interface SlopsmithVizFactory {
    (): SlopsmithRenderer;
    /** Auto-mode predicate; static on the factory, not the instance. */
    matchesArrangement?: (songInfo: SlopsmithSongInfo | Record<string, never>) => unknown;
    /** Optional static mirror of the instance `contextType`. */
    contextType?: '2d' | 'webgl2';
}

// ─── window.highway — the renderer API ──────────────────────────────────────

/** The object returned by `createHighway()` and exposed as `window.highway`. */
interface SlopsmithHighway {
    init(canvas: HTMLCanvasElement, container?: HTMLElement | null): void;
    resize(): void;
    connect(wsUrl: string, opts?: {
        onError?: (err: string) => void;
        onReady?: () => void;
        [key: string]: unknown;
    }): void;
    reconnect(filename: string, arrangement: number): void;
    stop(): void;

    setRenderScale(scale: number): void;
    getRenderScale(): number;
    getInverted(): boolean;
    setInverted(v: boolean): void;
    getLefty(): boolean;
    setLefty(on: boolean): void;

    setMastery(fraction: number): void;
    getMastery(): number;
    hasPhraseData(): boolean;

    setTime(t: number): void;
    getTime(): number;
    setAvOffset(ms: number): void;
    getAvOffset(): number;
    getBPM(t: number): number;
    getBeats(): SlopsmithBeat[];
    getAudioElement(): HTMLAudioElement | null;

    setVisible(v: boolean | null): void;
    isVisible(): boolean;

    getNotes(): SlopsmithNote[];
    getChords(): SlopsmithChord[];
    getChordTemplates(): SlopsmithChordTemplate[];
    getToneChanges(): SlopsmithToneChange[];
    getToneBase(): string;
    getSections(): SlopsmithSection[];
    getSongInfo(): SlopsmithSongInfo | Record<string, never>;
    getStringCount(): number;

    addDrawHook(fn: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void;
    removeDrawHook(fn: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void;
    fireDrawHooks(ctx: CanvasRenderingContext2D, w: number, h: number): void;

    setNoteStateProvider(fn: SlopsmithNoteStateProvider | null): void;
    getNoteStateProvider(): SlopsmithNoteStateProvider | null;
    getNoteState(note: SlopsmithNote, chartTime: number): SlopsmithNoteState | null;

    project(tOffset: number): { x: number; y: number; scale: number };
    fretX(fret: number, scale: number, w: number): number;
    fillTextUnmirrored(text: string, x: number, y: number): void;

    toggleLyrics(): void;
    getLyricsVisible(): boolean;
    setLyricsVisible(v: boolean): void;
    setOnLyricsChange(fn: (visible: boolean) => void): void;

    setRenderer(r: SlopsmithRenderer | null | undefined): void;
    isDefaultRenderer(): boolean;
}

// ─── window.slopsmith — event bus + namespaces ──────────────────────────────

/** Named event payloads carried on `window.slopsmith` CustomEvents (`event.detail`). */
interface SlopsmithEventMap {
    'song:ready': { songInfo: SlopsmithSongInfo };
    'song:play': unknown;
    'song:pause': unknown;
    'song:seek': { from: number; to: number; reason: string | null };
    'highway:visibility': { visible: boolean; canvas: HTMLCanvasElement };
    'highway:canvas-replaced': {
        oldCanvas: HTMLCanvasElement;
        newCanvas: HTMLCanvasElement;
        contextType: '2d' | 'webgl2';
    };
    'viz:reverted': unknown;
    [event: string]: unknown;
}

/** A labeled audio fader registered with the mixer (slopsmith#87). */
interface SlopsmithFaderSpec {
    id: string;
    label: string;
    unit?: string;
    min: number;
    max: number;
    step: number;
    defaultValue: number;
    getValue: () => number;
    setValue: (v: number) => void;
}

/** `window.slopsmith.audio` — mixer + song-volume surface (audio-mixer.js). */
interface SlopsmithAudioApi {
    registerFader(spec: SlopsmithFaderSpec): void;
    unregisterFader(id: string): void;
    getFaders(): SlopsmithFaderSpec[];
    openMixer(): void;
    closeMixer(restoreFocus?: boolean): void;
    toggleMixer(): void;
    applySongVolume(v?: number | null): Promise<number>;
    readSongVolume(): number;
}

/** `window.slopsmith.diagnostics` — client diagnostics surface (diagnostics.js). */
interface SlopsmithDiagnosticsApi {
    contribute(pluginId: string, payload: unknown): void;
    snapshot(): unknown;
    snapshotConsole(): unknown;
    snapshotHardware(): Promise<unknown>;
    snapshotUa(): unknown;
    snapshotLocalStorage(): unknown;
    snapshotContributions(): unknown;
}

/** `window.slopsmith` — the plugin event bus (an `EventTarget`). */
interface SlopsmithApi extends EventTarget {
    currentSong: unknown;
    isPlaying: boolean;
    navigate(screenId: string, params?: Record<string, unknown>): void;
    getNavParams(): Record<string, unknown>;
    emit<K extends keyof SlopsmithEventMap>(event: K, detail: SlopsmithEventMap[K]): void;
    emit(event: string, detail?: unknown): void;
    on(event: string, fn: (e: Event) => void, options?: AddEventListenerOptions | boolean): void;
    off(event: string, fn: (e: Event) => void, options?: EventListenerOptions | boolean): void;
    setLoop(a: number, b: number): unknown;
    clearLoop(): void;
    getLoop(): { loopA: number | null; loopB: number | null };
    /** Attached by audio-mixer.js after it loads. */
    audio?: SlopsmithAudioApi;
    /** Attached by diagnostics.js early in `<head>`. */
    diagnostics?: SlopsmithDiagnosticsApi;
}

// ─── Keyboard-shortcut API ──────────────────────────────────────────────────

/** A keyboard shortcut registration (see `window.registerShortcut`). */
interface SlopsmithShortcutSpec {
    /** `e.key` value or `e.code`. */
    key: string;
    description: string;
    scope?: 'global' | 'player' | 'library' | 'settings' | string;
    condition?: () => boolean;
    handler: (e: KeyboardEvent) => void;
}

/** A panel-scoped shortcut registry returned by `createShortcutPanel`. */
interface SlopsmithShortcutPanel {
    registerShortcut(spec: SlopsmithShortcutSpec): void;
    unregisterShortcut(key: string, scope?: string): boolean;
    clearShortcuts(): void;
}

// ─── Global augmentations ───────────────────────────────────────────────────

declare global {
    interface Window {
        /** Plugin event bus + namespaces. Owned by app.js. */
        slopsmith: SlopsmithApi;
        /** The shared highway renderer instance. */
        highway: SlopsmithHighway;
        /** Factory for additional highway instances (splitscreen panels). */
        createHighway(): SlopsmithHighway;
        /** Loads and plays a song into the player. */
        playSong(filename: string, arrangement?: number): Promise<void>;
        /** Switches the active single-page-app screen. */
        showScreen(id: string): Promise<void>;

        /** Keyboard-shortcut registry. */
        registerShortcut(options: SlopsmithShortcutSpec): void;
        unregisterShortcut(key: string, scope?: string): boolean;
        createShortcutPanel(id: string): SlopsmithShortcutPanel;
        setActiveShortcutPanel(id: string): void;
        getActiveShortcutPanel(): string;
        clearWindowShortcuts(windowId: string): number;
        getShortcutWindowId(): string;

        /** Desktop JUCE audio bridge — present only in slopsmith-desktop. */
        jucePlayer?: unknown;
        _juceMode?: boolean;
        _juceAudioUrl?: string;

        /** Lottie animation helper (lottie-api.js). */
        slopsmithLottie?: unknown;
        /** Guided-tour engine (tour-engine.js). */
        slopsmithTour?: unknown;

        /**
         * Visualization factories — one per `type: "visualization"` plugin,
         * keyed `slopsmithViz_<id>`. Indexed access is intentionally loose.
         */
        [vizFactory: `slopsmithViz_${string}`]: SlopsmithVizFactory;
    }
}

export {};
