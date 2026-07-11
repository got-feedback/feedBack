// Shared, MUTABLE player state.
//
// WHY A CONTAINER AND NOT PLAIN EXPORTS. An imported binding is read-only. Every
// slice carved out of app.js so far has only ever READ the state it shares
// (loopA/loopB, _audioSeekGen, currentFilename), so a getter hook was enough and no
// container was needed. That runs out here: count-in genuinely WRITES `isPlaying`
// (it starts and stops playback) and `lastAudioTime`. `import { isPlaying }` then
// `isPlaying = true` throws — the binding cannot be assigned to.
//
// So the state moves onto an object. `S.isPlaying = true` is a property write, which
// works from any module holding the same `S`. This is the same shape the stems,
// studio, and editor migrations converged on.
//
// It is deliberately SMALL. app.js has ~104 top-level `let` scalars; lifting all of
// them would be a ~977-site rewrite for no benefit, since most are private to one
// cluster and travel with it. Only the ones a carved module must WRITE belong here.
// Add to it when a carve actually needs it, not before.
//
// NB app.js's own 71 reference sites were rewritten mechanically — but from the AST,
// not by text substitution. Of 100 textual occurrences of these two names, only 71
// resolve to the module binding: 22 are member accesses (`someObj.isPlaying`), 4 are
// the local parameter of setPlayButtonState(isPlaying), one is an object key, and two
// are shorthand properties (`{ isPlaying }`) that must become `{ isPlaying: S.isPlaying }`.
// A blind find-and-replace corrupts all 29.
export const S = {
    /** Is the transport running? Written by playback, count-in, and the JUCE shims. */
    isPlaying: false,

    /**
     * The last audio position we saw, in seconds. Used to detect a seek that did not
     * land where it was asked to (JUCE can clamp; HTML5 can round).
     */
    lastAudioTime: 0,
};
