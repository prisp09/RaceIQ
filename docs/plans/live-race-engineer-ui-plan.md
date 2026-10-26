# Live race engineer UI implementation

Follow the [shared contract](live-race-engineer-contract.md) and [plan](live-race-engineer.md). UI owns client components, hooks, messages and defaults only. Fixtures must match the contract and never become production fallbacks.

## Tasks and acceptance
- U1: Settings → AI gets a Live Engineer section: enable toggle, provider and model pickers (reusing `AiProviderPicker` / `AiModelPicker`, so Claude Haiku 5.5 is recommended and preselected), mode selector (Quiet / Normal / Coach, **Pending** default), mic mode (Push to talk / Open mic / Off), PTT binding control ("Press a key or wheel button"), and voice picker with preview, rate and pitch.
- U2/E1: `useEngineer` hook subscribes to the `engineer` channel. It plays `engineer-say` through a priority speech queue on `speechSynthesis` (critical interrupts) and reports `engineer-speaking`. Voice selection prefers the saved `voiceURI`, then an en-GB male natural voice (Thomas, then Ryan, then any en-GB male).
- U3/E2/E4/E5: `SpeechToText` interface with a Web Speech adapter. Push to talk records while the global `engineer-ptt` is pressed or the on-screen button is held. Open mic uses voice activity detection and pauses while the engineer speaks. Final transcripts are sent as `engineer-ask`.
- U4: Engineer panel on the live dashboard: radio-style transcript (driver and engineer lines), mode quick switch, mic state indicator, typed question box, and a "Start engineer" button that provides the user gesture `speechSynthesis` needs.
- U5: All new text in locale messages across the 16 catalogs, keyboard access and visible focus, and responsive at phone width.

## Verification
In a real browser on Windows (Edge and Chrome): voice preview, a lap-summary callout during an ACC session, typed and spoken questions answered aloud, PTT while ACC has focus, and open mic with a headset. Record latency per step. Run typecheck, client tests and i18n key checks as supplements, not replacements for browser checks.
