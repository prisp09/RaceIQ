# Live race engineer backend implementation

Follow the [shared contract](live-race-engineer-contract.md) and [plan](live-race-engineer.md). Backend owns server, packages and apps/backend. UI proceeds independently against the contract.

## Tasks and acceptance
- B1: Settings fields and defaults from the contract in `server/runtime/config/settings.ts`. Add the `liveEngineer` feature to `server/ai/ai-features.ts`, resolved through `resolveAi` / `getModel`.
- B2/E1: `EngineerLiveState` fed from `server/telemetry/live-pipeline.ts`: broadcast port (packet, sectors, pit, live issues) and `onLapComplete`. It keeps the current lap, delta to best and last lap, predicted lap, fuel per lap (rolling average of valid laps), laps of fuel left, tyre temps and pressures, and the last lap's insights resolved to corners (`apps/backend/src/tracks/corner-resolution.ts`). Allocation-light at 60–100 Hz; no work on the hot path beyond counters.
- B3/E1/E3: Callout rules engine. Critical rules: low fuel, rapid pressure loss, pit window. Normal adds lap summary, personal best and sector best. Coach adds the top lap mistakes by corner and repeats. Mode filter, per-kind cooldowns, standing instructions and hold while the client reports speaking. Pure functions with unit tests from recorded fixtures.
- B4/E2/E3: Mastra `liveEngineerAgent` with short radio-style instructions (one or two sentences, no lists) and read-only tools: `get_live_snapshot`, `get_fuel`, `get_tyres`, `get_delta`, `get_last_lap_mistakes`, plus `set_instruction` / `clear_instruction` for standing instructions. Uses `getModel("liveEngineer", requestContext)`.
- B5/E4: Windows input helper on the `server/runtime/platform/tray.ts` pattern. A PowerShell script with an Add-Type C# shim: RegisterHotKey for the keyboard binding and winmm `joyGetPosEx` polling (about 50 Hz) for joystick buttons. Also device enumeration and bind-capture mode. Lifecycle tied to `engineerEnabled` and shutdown; it restarts on crash with backoff. **Pending:** hardware confirmation.
- B6/E2/E6: `engineer` WebSocket channel in `server/runtime/websocket-manager.ts`, plus the `/api/engineer/*` routes. Errors map to contract codes.

## Verification
Unit tests for rules and state using recorded ACC fixtures through the real pipeline. Integration test: replay a recording through the dev replay route with the engineer enabled and assert the `engineer-say` sequence per mode. Agent test with a stubbed model, plus one live Claude Haiku 5.5 check (manual). Windows helper smoke test on the user's PC: bind keyboard and wheel buttons, then press while ACC has focus. Run typecheck, unit/integration suites, lint, i18n keys and test shards.
