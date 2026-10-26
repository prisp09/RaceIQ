# Live race engineer integration contract

Requirements: [plan](live-race-engineer.md). Owners: [UI](live-race-engineer-ui-plan.md), [backend](live-race-engineer-backend-plan.md). This reflects what is implemented on `feature/live-race-engineer`.

## Settings
Existing GET/PUT `/api/settings` with partial-update merge. New fields, all required in complete settings and optional in partial requests:
- `engineerEnabled`: boolean, default `false`.
- `engineerMode`: `"quiet" | "normal" | "coach"`, default `"normal"`.
- `engineerMicMode`: `"push-to-talk" | "open-mic" | "off"`, default `"push-to-talk"`.
- `engineerPushToTalk`: `null | { kind: "keyboard"; vk: number; name: string } | { kind: "joystick"; deviceId: number; button: number; name: string }`, default `null`. Captured by `POST /api/engineer/bind`.
- `engineerVoiceURI`: `string | null`, default `null` (the client picks the best en-GB male voice). `engineerVoiceRate`: 0.7–1.3, default 0.95. `engineerVoicePitch`: 0.5–1.5, default 0.85. `engineerRadioFilter`: boolean, default `true`.
- `engineerProvider` / `engineerModel`: the `liveEngineer` AI feature's provider and model, same rules as the other AI features. The model defaults to `claude-haiku-5-5` when the provider is `anthropic`.

Invalid values return the existing 400 settings error.

## WebSocket channel `engineer`
Events go to every connected client as notifications; the client forwards `engineer-*` messages to the radio widget.

Server to client:
- `{ type: "engineer-say", id: string, kind: "callout" | "answer" | "ack", priority: 0 | 1 | 2, text: string, createdAt: string }`. Priority 2 (critical) interrupts lower-priority speech; the others queue. Text has at most about 30 words.
- `{ type: "engineer-heard", id: string, text: string, createdAt: string }`: a driver question as received.
- `{ type: "engineer-state", enabled: boolean, mode: EngineerMode, live: boolean, thinking: boolean }`.
- `{ type: "engineer-ptt", pressed: boolean, source: "keyboard" | "joystick" }`: global hotkey state from the backend helper.
- `{ type: "engineer-error", code: "NO_PROVIDER" | "NO_LIVE_SESSION" | "AI_FAILED" | "INPUT_HELPER_FAILED", message: string }`.

Client to server: questions use `POST /api/engineer/ask` (below). The client queues speech itself and pauses open-mic recognition while it speaks.

## HTTP
- GET `/api/engineer/state`: status plus the recent transcript.
- POST `/api/engineer/ask`, body `{ text }`: returns `{ text }` (also spoken via `engineer-say`), or 502 `{ error, code }`.
- GET `/api/engineer/input-devices`: `{ devices: { deviceId, deviceName, buttons }[] }` from the Windows helper. An empty list on other platforms.
- POST `/api/engineer/bind`, body `{ kind: "keyboard" | "joystick" }`: waits up to 10 s for the next key or button press. Returns 200 with the binding, or 408. It does not save; the client saves the binding through `/api/settings`.
- POST `/api/engineer/test`, body `{ text?: string }`: emits an `engineer-say` with `kind: "ack"` for voice preview over the real path.

## Observable acceptance
- E1: With the engineer enabled and a live ACC session, completing a lap in Normal mode produces one lap-summary `engineer-say` within 1 s of lap completion. Quiet mode produces none unless a critical rule fires.
- E2: A typed `engineer-ask` "How much fuel do I have?" during a live session returns an `answer` containing laps of fuel remaining, computed from live state, within 5 s using Claude Haiku 5.5.
- E3: A standing instruction ("tell me every time I lock up") produces a callout on the next detected lock-up, and stops after "stop the lock-up calls".
- E4: Global PTT pressed while another window has focus emits `engineer-ptt` true/false. The client records only while it is pressed.
- E5: Open mic sends one `engineer-ask` per spoken utterance. No transcript is sent while the engineer is speaking.
- E6: Without a configured provider, or without a live session, the server sends `engineer-error` with the matching code, and no crash.
