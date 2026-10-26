import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { authenticatedFetch } from "@/lib/rpc";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import { EngineerSpeaker, englishVoices, pickVoice } from "@/components/engineer/engineer-voice";
import { AiModelPicker } from "./AiPickers";
import { defaultModelForProvider } from "./recommended-model";

type Provider = { id: string; name: string };
type Model = { id: string; name: string };

const selectClass = "w-full max-w-xs rounded border border-app-border-input bg-app-surface px-3 py-1.5 text-sm text-app-text";

export function AiEngineerSection() {
  const { displaySettings } = useSettings();
  const save = useSaveSettings();
  const enabled = displaySettings.engineerEnabled ?? false;
  const provider = displaySettings.engineerProvider ?? "";
  const [binding, setBinding] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => englishVoices());
  const speaker = useRef<EngineerSpeaker | null>(null);

  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const update = () => setVoices(englishVoices());
    speechSynthesis.addEventListener("voiceschanged", update);
    update();
    return () => speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);

  const { data: providers = [] } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: async () => (await (await authenticatedFetch("/api/ai-providers")).json()) as Provider[],
  });
  const { data: models = [] } = useQuery({
    queryKey: ["ai-models", provider, "engineer"],
    enabled: provider !== "",
    queryFn: async () => {
      const body = (await (await authenticatedFetch(`/api/ai-models?providers=${encodeURIComponent(provider)}`)).json()) as Record<string, Model[]>;
      return body[provider] ?? [];
    },
  });

  const update = (patch: Record<string, unknown>) => save.mutate(patch);
  const selectedVoice = useMemo(() => pickVoice(displaySettings.engineerVoiceURI ?? null), [displaySettings.engineerVoiceURI, voices]);

  const bind = async () => {
    setBinding(true);
    setBindError(null);
    try {
      const res = await authenticatedFetch("/api/engineer/bind", { method: "POST" });
      const body = await res.json() as { binding?: unknown; error?: string };
      if (res.ok && body.binding) update({ engineerPushToTalk: body.binding });
      else setBindError(body.error ?? m.engineer_bind_failed());
    } catch {
      setBindError(m.engineer_bind_failed());
    } finally {
      setBinding(false);
    }
  };

  const testVoice = () => {
    speaker.current ??= new EngineerSpeaker(() => {});
    speaker.current.configure({
      voiceURI: displaySettings.engineerVoiceURI ?? null,
      rate: displaySettings.engineerVoiceRate ?? 0.95,
      pitch: displaySettings.engineerVoicePitch ?? 0.85,
      radioFilter: displaySettings.engineerRadioFilter ?? true,
    });
    speaker.current.unlock();
    speaker.current.say("preview", m.engineer_voice_preview_line(), 1);
  };

  return (
    <section className="mt-8 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-app-text">{m.engineer_settings_title()}</h3>
        <p className="mt-1 max-w-xl text-xs text-app-text-muted">{m.engineer_settings_desc()}</p>
      </div>
      <label className="flex items-center gap-2 text-sm text-app-text">
        <input id="engineer-enabled" type="checkbox" checked={enabled} onChange={(event) => update({ engineerEnabled: event.target.checked })} className="accent-app-accent" />
        {m.engineer_enable()}
      </label>
      {enabled && (
        <div className="space-y-4">
          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="engineer-mode" className="mb-1 block text-xs text-app-text-muted">{m.engineer_mode_label()}</Label>
              <select id="engineer-mode" className={selectClass} value={displaySettings.engineerMode ?? "normal"} onChange={(event) => update({ engineerMode: event.target.value })}>
                <option value="quiet">{m.engineer_mode_quiet_desc()}</option>
                <option value="normal">{m.engineer_mode_normal_desc()}</option>
                <option value="coach">{m.engineer_mode_coach_desc()}</option>
              </select>
            </div>
            <div>
              <Label htmlFor="engineer-mic" className="mb-1 block text-xs text-app-text-muted">{m.engineer_mic_label()}</Label>
              <select id="engineer-mic" className={selectClass} value={displaySettings.engineerMicMode ?? "push-to-talk"} onChange={(event) => update({ engineerMicMode: event.target.value })}>
                <option value="push-to-talk">{m.engineer_mic_ptt()}</option>
                <option value="open-mic">{m.engineer_mic_open()}</option>
                <option value="off">{m.engineer_mic_off()}</option>
              </select>
            </div>
          </div>

          <div>
            <Label className="mb-1 block text-xs text-app-text-muted">{m.engineer_ptt_label()}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded border border-app-border-input bg-app-surface px-2 py-1 text-sm text-app-text">
                {displaySettings.engineerPushToTalk?.name ?? m.engineer_ptt_none()}
              </span>
              <Button variant="app-outline" size="app-sm" onClick={() => void bind()} disabled={binding}>
                {binding ? m.engineer_ptt_waiting() : m.engineer_ptt_set()}
              </Button>
              {displaySettings.engineerPushToTalk && (
                <Button variant="app-ghost" size="app-sm" onClick={() => update({ engineerPushToTalk: null })}>{m.engineer_ptt_clear()}</Button>
              )}
            </div>
            <p className="mt-1 max-w-xl text-xs text-app-text-muted">{m.engineer_ptt_help()}</p>
            {bindError && <p role="alert" className="mt-1 text-xs text-status-danger">{bindError}</p>}
          </div>

          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="engineer-voice" className="mb-1 block text-xs text-app-text-muted">{m.engineer_voice_label()}</Label>
              <select id="engineer-voice" className={selectClass} value={displaySettings.engineerVoiceURI ?? ""} onChange={(event) => update({ engineerVoiceURI: event.target.value || null })}>
                <option value="">{m.engineer_voice_auto({ voice: selectedVoice?.name ?? m.engineer_voice_none() })}</option>
                {voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}
              </select>
              {voices.length > 0 && !voices.some((voice) => voice.lang.toLowerCase() === "en-gb") && (
                <p className="mt-1 text-xs text-app-text-muted">{m.engineer_voice_no_british()}</p>
              )}
            </div>
            <div>
              <Label htmlFor="engineer-rate" className="mb-1 block text-xs text-app-text-muted">{m.engineer_voice_rate({ value: (displaySettings.engineerVoiceRate ?? 0.95).toFixed(2) })}</Label>
              <input id="engineer-rate" type="range" min={0.7} max={1.3} step={0.05} value={displaySettings.engineerVoiceRate ?? 0.95} onChange={(event) => update({ engineerVoiceRate: Number(event.target.value) })} className="w-full accent-app-accent" />
            </div>
            <div>
              <Label htmlFor="engineer-pitch" className="mb-1 block text-xs text-app-text-muted">{m.engineer_voice_pitch({ value: (displaySettings.engineerVoicePitch ?? 0.85).toFixed(2) })}</Label>
              <input id="engineer-pitch" type="range" min={0.5} max={1.5} step={0.05} value={displaySettings.engineerVoicePitch ?? 0.85} onChange={(event) => update({ engineerVoicePitch: Number(event.target.value) })} className="w-full accent-app-accent" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-app-text">
              <input id="engineer-radio-filter" type="checkbox" checked={displaySettings.engineerRadioFilter ?? true} onChange={(event) => update({ engineerRadioFilter: event.target.checked })} className="accent-app-accent" />
              {m.engineer_radio_filter()}
            </label>
            <Button variant="app-outline" size="app-sm" onClick={testVoice}>{m.engineer_voice_test()}</Button>
          </div>

          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="engineer-provider" className="mb-1 block text-xs text-app-text-muted">{m.engineer_provider_label()}</Label>
              <select
                id="engineer-provider"
                className={selectClass}
                value={provider}
                onChange={(event) => update({ engineerProvider: event.target.value, engineerModel: defaultModelForProvider(event.target.value) })}
              >
                <option value="">{m.engineer_provider_chat()}</option>
                {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
            {provider !== "" && (
              <div>
                <Label htmlFor="engineer-model" className="mb-1 block text-xs text-app-text-muted">{m.ai_model_label()}</Label>
                <AiModelPicker id="engineer-model" value={displaySettings.engineerModel ?? ""} onChange={(value) => update({ engineerModel: value })} models={models} />
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
