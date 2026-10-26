# Live race engineer

Status: draft. Owners: [contract](live-race-engineer-contract.md), [backend](live-race-engineer-backend-plan.md), [UI](live-race-engineer-ui-plan.md). Built on `feature/anthropic-compatible-headers` (Claude provider) in branch `feature/live-race-engineer`.

## Goal
A radio-style race engineer that talks to the driver during a live session. It stays quiet or speaks up depending on the selected mode, calls out mistakes and race-critical events, and answers spoken questions about live telemetry. It also accepts standing instructions ("tell me every time I lock up").

## Decisions
| Topic | Decision | State |
| --- | --- | --- |
| Speech to text | Phase 1: browser Web Speech API behind a swappable `SpeechToText` interface. Phase 2: local whisper.cpp as the private, offline option. | Decided |
| Text to speech | Browser `speechSynthesis`. Default voice: a mature British male (Edge "Microsoft Thomas Online (Natural) – English (United Kingdom)"), falling back to the closest `en-GB` male voice. Rate and pitch are adjustable. Optional later: offline Windows SAPI or a cloud voice provider. The voice is generic; it is not modeled on any real person. | Decided |
| AI model | New `liveEngineer` AI feature through the existing provider stack. Claude (Anthropic) with Claude Haiku 5.5 recommended. | Decided |
| Mic input | Push to talk and open mic are both required. Off is also available. | Decided |
| Push-to-talk binding | Global keyboard key and wheel/button-box button that work while the game has focus. | **Pending: user's hardware (wheel or button box model, or keyboard)** |
| Verbosity modes | Proposed Quiet / Normal / Coach (see below). | **Pending: confirm modes and default** |
| Upstream | Whether to open an issue on SpeedHQ/RaceIQ before the PR. | **Pending** |

## Verbosity modes (proposed)
- **Quiet:** answers questions and follows standing instructions. Proactive calls are critical only: fuel for fewer than 2 laps, rapid tyre pressure loss, pit window open.
- **Normal:** Quiet plus a lap summary after each lap (lap time, delta to best, personal best or sector best), and fuel/tyre status every few laps.
- **Coach:** Normal plus the top one or two mistakes of the lap, named by corner ("Lock-up into Turn 1, front left. Brake a touch earlier."), and repeat-mistake reminders.

Proactive calls are template-based (no AI), with priorities, per-type cooldowns and a global "radio busy" lock, so they are instant and free. AI is used for questions and on-request coaching, and answers in one or two short sentences.

## Architecture
1. **Live state (backend).** An engineer service subscribes to the live pipeline (`server/telemetry/live-pipeline.ts` broadcast port and `onLapComplete`). It keeps a rolling state: the latest packet, sector tracker output (delta to best and last lap, predicted lap), pit tracker, live issues (`detectLiveIssues`), fuel-per-lap estimate, and the last lap's insights resolved to track corners.
2. **Callout rules (backend).** Deterministic rules turn state changes into callouts `{id, kind, priority, text}`. A mode filter, cooldowns and standing instructions decide which callouts are emitted.
3. **Engineer agent (backend).** A Mastra agent (`liveEngineer` feature) with read-only tools over live state answers transcribed questions and registers standing instructions.
4. **Transport.** The existing WebSocket gets an `engineer` channel: the server sends speech and state events; the client sends questions and PTT state.
5. **Global input (backend, Windows).** A PowerShell helper (same pattern as `server/runtime/platform/tray.ts`) registers a keyboard hotkey (RegisterHotKey) and polls wheel and button-box buttons (winmm joystick API). It reports PTT down/up to the backend, which relays it over the `engineer` channel.
6. **Voice (client).** A `SpeechToText` adapter (Web Speech API in phase 1), voice activity detection for open mic, mic muted while the engineer speaks, and `speechSynthesis` playback with a priority queue.
7. **UI (client).** An Engineer panel with mode, mic mode, PTT binding, voice picker with preview, and a transcript. Settings live under Settings → AI.

## Phases
1. Live state, callout rules, `engineer` channel, browser text-to-speech, typed questions, Engineer panel. Measures end-to-end latency.
2. Voice input: Web Speech push to talk (in-app button and global hotkey), open mic with voice activity detection.
3. Wheel/button-box binding and on-request coaching instructions.
4. Local whisper.cpp speech to text.

## Risks
- Browser speech recognition and synthesis while the RaceIQ tab is in the background and the game has focus. Prototype on Windows before phase 2. `speechSynthesis` needs one user click per session.
- Wheel button support via winmm covers DirectInput devices up to 32 buttons; verify on the user's hardware.
- Spoken answers take about 2–3 s end to end (speech to text, model, speech).
- Open mic false triggers and echo; a headset is recommended, and an optional wake word may be needed.
- Coverage is best in ACC (100 Hz shared memory). Other games depend on their detectors.
