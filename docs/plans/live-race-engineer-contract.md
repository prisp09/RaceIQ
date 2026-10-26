# Live race engineer integration contract

Requirements: [plan](live-race-engineer.md). Owners: [UI](live-race-engineer-ui-plan.md), [backend](live-race-engineer-backend-plan.md). Items marked **Pending** wait on the user's decisions listed in the plan.

## Settings
Existing GET/PUT `/api/settings` with partial-update merge. New fields, all required in complete settings and optional in partial requests:
- `engineerEnabled`: boolean, default `false`.
- `engineerMode`: `"quiet" | "normal" | "coach"`, default **Pending** (proposed `"normal"`).
- `engineerMicMode`: `"push-to-talk" | "open-mic" | "off"`, default `"push-to-talk"`.
- `engineerPushToTalk`: `null | { kind: "keyboard"; key: string; modifiers: ("ctrl"|"alt"|"shift")[] } | { kind: "joystick"; deviceId: string; deviceName: string; button: number }`, default `null`. **Pending:** device support confirmed after hardware answer.
- `engineerVoice`: `{ voiceURI: string | null; rate: number; pitch: number }`, default `{ voiceURI: null, rate: 1, pitch: 0.9 }`. `voiceURI: null` means the client picks the best en-GB male voice. Rate is 0.7–1.3 and pitch is 0.5–1.5.
- `engineerProvider` / `engineerModel`: the `liveEngineer` AI feature's provider and model, same rules as the other AI features. The model defaults to `claude-haiku-5-5` when the provider is `anthropic`.

Invalid values return the existing 400 settings error.

## WebSocket channel `engineer`
The client subscribes with the existing subscription message shape: `{ type: "subscribe", channel: "engineer" }`.

Server to client:
- `{ type: "engineer-say", id: string, kind: "callout" | "answer" | "ack", priority: 0 | 1 | 2, text: string, createdAt: string }`. Priority 2 (critical) interrupts lower-priority speech; the others queue. Text has at most about 30 words.
- `{ type: "engineer-state", enabled: boolean, mode: EngineerMode, live: boolean, thinking: boolean }`.
- `{ type: "engineer-ptt", pressed: boolean, source: "keyboard" | "joystick" }`: global hotkey state from the backend helper.
- `{ type: "engineer-error", code: "NO_PROVIDER" | "NO_LIVE_SESSION" | "AI_FAILED" | "INPUT_HELPER_FAILED", message: string }`.

Client to server:
- `{ type: "engineer-ask", id: string, text: string }`: a final transcript or typed question. The answer arrives as `engineer-say` with `kind: "answer"`.
- `{ type: "engineer-speaking", speaking: boolean }`: lets the server hold proactive callouts while speech plays.

## HTTP
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
