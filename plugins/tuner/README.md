# FeedBack Tuner Plugin

<img width="290" height="362" alt="grafik" src="https://github.com/user-attachments/assets/879440e9-b680-481b-9091-ddfa73319078" />


A real-time guitar and bass tuner plugin for [FeedBack](https://github.com/got-feedback/feedBack).

This plugin adds a floating "Tuner" button to the FeedBack interface, providing a high-accuracy chromatic tuner with support for multiple presets, custom tunings, and automatic song tuning detection.

## Features

- **Real-time Pitch Detection**: Uses the YIN algorithm for robust and accurate frequency tracking.
- **Multiple Presets**: Includes common guitar and bass tunings (Standard, Drop D, DADGAD, Open G, etc.).
- **Automatic Song Tuning**: Detects and selects the correct tuning for the currently playing song in the FeedBack player.
- **Manual & Auto Tracking**: Automatically estimates the closest string or allows manual selection for focused tuning.
- **Visual Feedback**: Large cents-deviation gauge, frequency display, and color-coded indicators.
- **Custom Tunings**: Add your own tunings via note names (e.g., E2, A2) or Hz frequencies in the settings.
- **Audio Device Selection**: Choose specific input devices and channels (Mono, Left, Right) for professional interfaces.
- **Themable UI**: Styled with Tailwind CSS to match your FeedBack theme.
- **Visualizations**: Pick from different visualizations to suit your needs (Currently: Default, Strobe, Analogue Gauge, Mace Fx III, and Toilet Tuner)

## Available Visualizations

| Name | Image |
|------|-------|
| Default | <img width="450" height="261" alt="grafik" src="https://github.com/user-attachments/assets/7b63cac5-07c8-4fea-88ba-60e051a3cbb4" /> |
| Strobe | <img width="450" alt="grafik" src="https://github.com/user-attachments/assets/d73f9434-dd2b-4d36-a21b-ceff4cd278a2" /> |
| Analogue Gauge | <img width="450" alt="grafik" src="https://github.com/user-attachments/assets/44918f20-fc56-4219-9081-8c46bf473e20" /> |
| Mace-Fx III | <img width="450" alt="grafik" src="https://github.com/user-attachments/assets/bd80a850-668e-4217-861b-50a6015f4f2d" /> |
| Bender PP-Tiny | <img width="450" alt="grafik" src="https://github.com/user-attachments/assets/7e6fe983-240d-4cf7-9622-ea5203bdafc7" /> |
| CHEF MT-3 | <img width="450" alt="grafik" src="https://github.com/user-attachments/assets/7f812395-0cd6-4091-9fb3-c4c16a8f2afe" /> |
| Toilet Tuner | <img width="450" alt="grafik" src="https://github.com/user-attachments/assets/07925cd6-386d-4089-8278-a3e6eb499685" /> |

## Installation

### Download a Release
1. Download one of the [Releases](https://github.com/OmikronApex/feedBack-plugin-tuner/releases)
2. Extract it to your plugins folder
3. Restart FeedBack

### Update Manager
The plugin is listed in the official plugin repository, so it can also be installed directly via the [Update Manager](https://github.com/masc0t/feedBack-update-manager)

### Git
```bash
cd /path/to/feedBack/plugins
git clone https://github.com/OmikronApex/feedBack-plugin-tuner.git tuner
# Restart FeedBack (or restart your docker container)
docker compose restart
```

## How to Use

1. Click the **Tuner** button at the bottom-right of the screen (or the "Tuner" button in the player controls).
2. The tuner will automatically default to the **Current Song** tuning if you are in the player.
3. Select other presets or custom tunings from the dropdown menu if needed.
4. Pluck a string. The tuner will automatically detect the closest string in the selected tuning.
5. (Optional) Click a specific note button in the tuner window to lock onto that string (useful for very out-of-tune strings).
6. Adjust your tuning until the needle is centered and the indicator turns green.

## Configuration

### In-App Settings
Click the ⚙️ icon in the tuner window to access:
- **Audio Input**: Select your preferred microphone or audio interface.
- **Channel Selection**: Choose between Mono (mixed), Left, or Right channels (ideal for multi-channel audio interfaces).
- **Visualization**: Choose between different visualization options.

<img width="303" height="268" alt="grafik" src="https://github.com/user-attachments/assets/54310baf-56b0-4a19-a076-5450f6d3cc9d" />


### Plugin Manager
Access advanced settings via the FeedBack Plugin Manager (Settings -> Plugins -> Tuner):
- **Floating Button**: Toggle the visibility of the tuner button on the main interface.
- **Tuning Visibility**: Toggle which built-in tunings appear in your menu.
- **Custom Tunings**: Define your own tuning presets by entering a name and a list of notes/frequencies.

<img width="640" height="1025" alt="grafik" src="https://github.com/user-attachments/assets/d67585a2-f376-44bb-8c9b-64a0de732dbd" />



## Changelog

### [1.3.1] - 2026-06-04
- JUCE bridge audio input: when running inside FeedBack Desktop the tuner taps the engine's raw audio stream (`getRawAudioFrame`) and runs its own tuning-optimised YIN over it, falling back to the browser microphone pipeline otherwise.
- Fixed octave-low / sub-harmonic pitch errors (canonical YIN absolute-threshold selection) and added octave-aware nearest-string matching.
- "Free Tune" is now remembered as your last tuning, so it persists across sessions instead of resetting to a preset each time.
- Relocated visualization SVG assets to `visualization/assets/`, served via the dedicated `/api/plugins/tuner/viz-assets/` route (supersedes the 1.3.0 note about the root `assets/` directory).
- Removed the legacy Tailwind stylesheet (`assets/plugin.css`) and its `styles` manifest entry — supersedes the 1.3.0 stylesheet note below.

### [1.3.0] - 2026-06-01
- Added PP-Tiny visualization: inspired by the Fender PT-100 chromatic tuner panel, with a curved 11-LED arc, 8-segment note display with split centre bar, and always-on BATT. indicator.
- Added CHEF MT-3 visualization: inspired by the BOSS TU-3, featuring a 90° curved glass gauge arc, 51 tick marks, red 7-segment display, and rubber mode/brightness buttons.
- Refactored `screen.js` into focused modules: audio pipeline extracted to `utils/audio.js`, UI layer extracted to `utils/ui.js` (shared-state factory pattern). `screen.js` reduced from ~1060 to ~300 lines.
- Normalised `DEFAULT_TUNINGS` keys to instrument keys (`guitar-6`, `bass-4`, etc.) — removes the internal group-name lookup table.
- Added plugin stylesheet (`assets/plugin.css`) via the FeedBack styles contract, ensuring arbitrary Tailwind classes render correctly for runtime-installed users.
- Moved SVG assets (`Bathroom.svg`, `Plunger.svg`, `Toiletbowl.svg`) to the root `assets/` directory; removed the now-redundant custom asset route from `routes.py`.
- Moved Toilet Tuner to the end of the visualization picker list.

### [1.2.8] - 2026-05-31
- Added Toilet Tuner visualization: bathroom scene background with a plunger that slides left/right proportional to cents deviation; dips into the toilet bowl when in tune (±2 cents) and shows a 💩 emoji on the wall calendar.

### [1.2.7] - 2026-05-31
- Added Mace Fx III visualization: dark navy LCD-style panel with a chromatic tick gauge, inward directional arrows, large note/octave readout, a rotating pink strobe semicircle, and a pixelated grid overlay.
- Improved tuner detection stability: median frequency filtering plus YIN octave correction (rejects both overtone and undertone errors) keeps low strings from jumping octaves as they decay.
- Added pluck-attack warm-up so the noisy string-attack transient no longer shows a wrong pitch before settling.
- Added frame-to-frame octave continuity tracking to eliminate residual octave flips.

### [1.2.6] - 2026-05-31
- Added Analogue Gauge visualization: vintage mechanical instrument panel with rotating frequency and note name drums, semicircular needle gauge, and a physical-style in-tune lightbulb.
- Added AUTO mode indicator lamp: lights when Free Tune is active, dims on manual string lock.
- Visualizations now receive tuning mode context (`free` / `auto` / `manual`) from the core plugin.

### [1.2.5] - 2026-05-30
- Improved mic error handling: better error messages and inline error banner instead of browser alert.
- Fixed Real Tone Cable (mono-only USB audio) support when the device is explicitly selected.
- Fixed error banner persisting across screen navigation after a mic failure.
- Fixed stale error banner remaining visible after a successful device switch.
- Fixed silent failure when audio restart fails during device switch.

### [1.2.4] - 2026-05-25
- Improved low-frequency detection by lowering minimum detectable frequency to 20Hz.

### [1.2.3] - 2026-05-19
- Refactored tuner plugin: simplified script loading, modularized audio pipeline, and improved visualization state management.
- Fixed issue where targeting a specific string was impossible when no audio input was present.

### [1.2.2] - 2026-05-18
- Added missing YIN-worker script.

### [1.2.1] - 2026-05-18
- Added graceful handling for audio device errors by resetting device ID on exceptions.

### [1.2.0] - 2026-05-18
- Introduced Strobe Tuner visualization.
- Modularized visualization handling and improved state management.
- Enhanced tuning synchronization logic.

### [1.1.0] - 2026-05-10
- Added 5-string bass tunings.
- Removed unnecessary scroll limit in settings UI.

### [1.0.3] - 2026-05-10
- Visual polish for the settings page.
- Added toggle for floating tuner button visibility.

### [1.0.2] - 2026-05-10
- Added microphone and channel selection settings.
- Integrated tuner button into the player UI.
- Added dynamic tuning detection within the player.

### [1.0.1] - 2026-05-10
- Fixed floating button reappearing on song end.
- Improved tuner button injection in player UI.

### [1.0.0] - 2026-05-10
- Initial release.

## License

MIT
