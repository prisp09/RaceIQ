import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { authenticatedFetch } from "@/lib/rpc";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import type { DisplaySettings } from "@/stores/telemetry";
import { m } from "@/paraglide/messages";
import { EngineerModePicker } from "@/components/engineer/EngineerModePicker";
import { EngineerSpeaker, englishVoices, pickVoice } from "@/components/engineer/engineer-voice";
import { AiModelPicker } from "./AiPickers";
import { defaultModelForProvider, modelsOrFallback } from "./recommended-model";

type Provider = { id: string; name: string };
type Model = { id: string; name: string };
type EngineerDraft = {
  engineerEnabled: boolean;
  engineerMode: NonNullable<DisplaySettings["engineerMode"]>;
  engineerMicMode: NonNullable<DisplaySettings["engineerMicMode"]>;
  engineerPushToTalk: DisplaySettings["engineerPushToTalk"] | null;
  engineerVoiceURI: string | null;
  engineerVoiceRate: number;
  engineerVoicePitch: number;
  engineerRadioFilter: boolean;
  engineerTipLeadSeconds: number;
  engineerRadioFilterLevel: number;
  engineerAzureRegion: string;
  engineerProvider: NonNullable<DisplaySettings["engineerProvider"]>;
  engineerModel: string;
};

const selectClass = "w-full max-w-xs rounded border border-app-border-input bg-app-surface px-3 py-1.5 text-sm text-app-text";
const SLIDER_SAVE_DELAY_MS = 400;

function draftFrom(settings: Partial<DisplaySettings>): EngineerDraft {
  return {
    engineerEnabled: settings.engineerEnabled ?? false,
    engineerMode: settings.engineerMode ?? "normal",
    engineerMicMode: settings.engineerMicMode ?? "push-to-talk",
    engineerPushToTalk: settings.engineerPushToTalk ?? null,
    engineerVoiceURI: settings.engineerVoiceURI ?? null,
    engineerVoiceRate: settings.engineerVoiceRate ?? 0.95,
    engineerVoicePitch: settings.engineerVoicePitch ?? 0.85,
    engineerRadioFilter: settings.engineerRadioFilter ?? true,
    engineerTipLeadSeconds: settings.engineerTipLeadSeconds ?? 5,
    engineerRadioFilterLevel: settings.engineerRadioFilterLevel ?? 0.5,
    engineerAzureRegion: settings.engineerAzureRegion ?? "",
    engineerProvider: settings.engineerProvider ?? "",
    engineerModel: settings.engineerModel ?? "",
  };
}

export function AiEngineerSection() {
  const { displaySettings, settingsLoaded } = useSettings();
  const save = useSaveSettings();
  // Controls read local state so clicks apply instantly; saves run in the background.
  const [draft, setDraft] = useState<EngineerDraft>(() => draftFrom(displaySettings as Partial<DisplaySettings>));
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current || !settingsLoaded) return;
    synced.current = true;
    setDraft(draftFrom(displaySettings as Partial<DisplaySettings>));
  }, [settingsLoaded, displaySettings]);

  const [binding, setBinding] = useState(false);
  const [azureKey, setAzureKey] = useState("");
  const [azureKeySet, setAzureKeySet] = useState(Boolean(displaySettings.azureSpeechKeySet));
  useEffect(() => setAzureKeySet(Boolean(displaySettings.azureSpeechKeySet)), [displaySettings.azureSpeechKeySet]);
  const saveAzureKey = async (value: string) => {
    const res = await authenticatedFetch("/api/ai-key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "azure-speech", apiKey: value.trim() }) }).catch(() => null);
    if (res?.ok) { setAzureKeySet(value.trim() !== ""); setAzureKey(""); }
  };
  const [bindError, setBindError] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => englishVoices());
  const speaker = useRef<EngineerSpeaker | null>(null);
  const sliderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSlider = useRef<Partial<EngineerDraft>>({});

  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const update = () => setVoices((current) => {
      const next = englishVoices();
      return next.length === current.length && next.every((voice, index) => voice.voiceURI === current[index]?.voiceURI) ? current : next;
    });
    speechSynthesis.addEventListener("voiceschanged", update);
    update();
    return () => speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);

  useEffect(() => () => { if (sliderTimer.current) clearTimeout(sliderTimer.current); }, []);

  const provider = draft.engineerProvider;
  const { data: providers = [] } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: async () => (await (await authenticatedFetch("/api/ai-providers")).json()) as Provider[],
    staleTime: Infinity,
  });
  const { data: fetchedModels = [] } = useQuery({
    queryKey: ["engineer-ai-models", provider],
    enabled: provider !== "",
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const body = (await (await authenticatedFetch(`/api/ai-models?providers=${encodeURIComponent(provider)}`)).json()) as Record<string, Model[]>;
      return body[provider] ?? [];
    },
  });
  const models = modelsOrFallback(provider, fetchedModels);

  const update = (patch: Partial<EngineerDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    save.mutate(patch);
  };
  const updateSlider = (patch: Partial<EngineerDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    pendingSlider.current = { ...pendingSlider.current, ...patch };
    if (sliderTimer.current) clearTimeout(sliderTimer.current);
    sliderTimer.current = setTimeout(() => {
      const pending = pendingSlider.current;
      pendingSlider.current = {};
      save.mutate(pending);
    }, SLIDER_SAVE_DELAY_MS);
  };

  const selectedVoice = useMemo(() => pickVoice(draft.engineerVoiceURI), [draft.engineerVoiceURI, voices]);
  const hasBritishVoice = useMemo(() => voices.some((voice) => voice.lang.toLowerCase() === "en-gb"), [voices]);

  const bind = async () => {
    setBinding(true);
    setBindError(null);
    try {
      const res = await authenticatedFetch("/api/engineer/bind", { method: "POST" });
      const body = await res.json() as { binding?: EngineerDraft["engineerPushToTalk"]; error?: string };
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
      voiceURI: draft.engineerVoiceURI, rate: draft.engineerVoiceRate, pitch: draft.engineerVoicePitch,
      radioFilter: draft.engineerRadioFilter, radioLevel: draft.engineerRadioFilterLevel,
      azure: Boolean(azureKeySet && draft.engineerAzureRegion),
    });
    speaker.current.unlock();
    speaker.current.stop();
    speaker.current.say("preview", m.engineer_voice_preview_line(), 1);
  };

  return (
    <section className="mt-8 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-app-text">{m.engineer_settings_title()}</h3>
        <p className="mt-1 max-w-xl text-xs text-app-text-muted">{m.engineer_settings_desc()}</p>
        <p className="mt-2 max-w-xl text-xs text-app-text-muted">{m.engineer_privacy_notice()}</p>
      </div>
      <label className="flex items-center gap-2 text-sm text-app-text">
        <input id="engineer-enabled" type="checkbox" checked={draft.engineerEnabled} onChange={(event) => update({ engineerEnabled: event.target.checked })} className="accent-app-accent" />
        {m.engineer_enable()}
      </label>
      {draft.engineerEnabled && (
        <div className="space-y-4">
          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="engineer-mode" className="mb-1 block text-xs text-app-text-muted">{m.engineer_mode_label()}</Label>
              <EngineerModePicker id="engineer-mode" value={draft.engineerMode} onChange={(mode) => update({ engineerMode: mode })} />
              {draft.engineerMode === "co-driver" && (
                <div className="mt-3">
                  <Label htmlFor="engineer-tip-lead" className="mb-1 block text-xs text-app-text-muted">{m.engineer_tip_lead({ value: draft.engineerTipLeadSeconds.toFixed(1) })}</Label>
                  <input id="engineer-tip-lead" type="range" min={2} max={10} step={0.5} value={draft.engineerTipLeadSeconds} onChange={(event) => updateSlider({ engineerTipLeadSeconds: Number(event.target.value) })} className="w-full accent-app-accent" />
                  <p className="mt-1 text-xs text-app-text-muted">{m.engineer_tip_lead_help()}</p>
                </div>
              )}
            </div>
            <div>
              <Label htmlFor="engineer-mic" className="mb-1 block text-xs text-app-text-muted">{m.engineer_mic_label()}</Label>
              <select id="engineer-mic" className={selectClass} value={draft.engineerMicMode} onChange={(event) => update({ engineerMicMode: event.target.value as EngineerDraft["engineerMicMode"] })}>
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
                {draft.engineerPushToTalk?.name ?? m.engineer_ptt_none()}
              </span>
              <Button variant="app-outline" size="app-sm" onClick={() => void bind()} disabled={binding}>
                {binding ? m.engineer_ptt_waiting() : m.engineer_ptt_set()}
              </Button>
              {draft.engineerPushToTalk && (
                <Button variant="app-ghost" size="app-sm" onClick={() => update({ engineerPushToTalk: null })}>{m.engineer_ptt_clear()}</Button>
              )}
            </div>
            <p className="mt-1 max-w-xl text-xs text-app-text-muted">{m.engineer_ptt_help()}</p>
            {bindError && <p role="alert" className="mt-1 text-xs text-status-danger">{bindError}</p>}
          </div>

          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="engineer-voice" className="mb-1 block text-xs text-app-text-muted">{m.engineer_voice_label()}</Label>
              <select id="engineer-voice" className={selectClass} value={draft.engineerVoiceURI ?? ""} onChange={(event) => update({ engineerVoiceURI: event.target.value || null })}>
                <option value="">{m.engineer_voice_auto({ voice: selectedVoice?.name ?? m.engineer_voice_none() })}</option>
                {voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}
              </select>
              {voices.length > 0 && !hasBritishVoice && <p className="mt-1 text-xs text-app-text-muted">{m.engineer_voice_no_british()}</p>}
            </div>
            <div>
              <Label htmlFor="engineer-rate" className="mb-1 block text-xs text-app-text-muted">{m.engineer_voice_rate({ value: draft.engineerVoiceRate.toFixed(2) })}</Label>
              <input id="engineer-rate" type="range" min={0.7} max={1.3} step={0.05} value={draft.engineerVoiceRate} onChange={(event) => updateSlider({ engineerVoiceRate: Number(event.target.value) })} className="w-full accent-app-accent" />
            </div>
            <div>
              <Label htmlFor="engineer-pitch" className="mb-1 block text-xs text-app-text-muted">{m.engineer_voice_pitch({ value: draft.engineerVoicePitch.toFixed(2) })}</Label>
              <input id="engineer-pitch" type="range" min={0.5} max={1.5} step={0.05} value={draft.engineerVoicePitch} onChange={(event) => updateSlider({ engineerVoicePitch: Number(event.target.value) })} className="w-full accent-app-accent" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-app-text">
              <input id="engineer-radio-filter" type="checkbox" checked={draft.engineerRadioFilter} onChange={(event) => update({ engineerRadioFilter: event.target.checked })} className="accent-app-accent" />
              {m.engineer_radio_filter()}
            </label>
            <Button variant="app-outline" size="app-sm" onClick={testVoice}>{m.engineer_voice_test()}</Button>
          </div>
          {draft.engineerRadioFilter && (
            <div className="max-w-xs">
              <Label htmlFor="engineer-radio-level" className="mb-1 block text-xs text-app-text-muted">{m.engineer_radio_filter_level({ value: String(Math.round(draft.engineerRadioFilterLevel * 100)) })}</Label>
              <input id="engineer-radio-level" type="range" min={0} max={1} step={0.05} value={draft.engineerRadioFilterLevel} onChange={(event) => updateSlider({ engineerRadioFilterLevel: Number(event.target.value) })} className="w-full accent-app-accent" />
            </div>
          )}
          <div className="max-w-xl space-y-2 rounded border border-app-border-input p-3">
            <p className="text-sm font-medium text-app-text">{m.engineer_azure_title()}</p>
            <p className="text-xs text-app-text-muted">{m.engineer_azure_help()}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label htmlFor="engineer-azure-key" className="mb-1 block text-xs text-app-text-muted">{m.engineer_azure_key()}</Label>
                <div className="flex items-center gap-1.5">
                  <input id="engineer-azure-key" type="password" autoComplete="new-password" value={azureKey} onChange={(event) => setAzureKey(event.target.value)} onBlur={() => { if (azureKey.trim()) void saveAzureKey(azureKey); }} placeholder={azureKeySet ? m.ai_key_stored_placeholder() : ""} className={selectClass + " font-mono"} />
                  {azureKeySet && <Button variant="app-ghost" size="app-sm" onClick={() => void saveAzureKey("")}>{m.engineer_ptt_clear()}</Button>}
                </div>
              </div>
              <div>
                <Label htmlFor="engineer-azure-region" className="mb-1 block text-xs text-app-text-muted">{m.engineer_azure_region()}</Label>
                <input id="engineer-azure-region" value={draft.engineerAzureRegion} onChange={(event) => setDraft((current) => ({ ...current, engineerAzureRegion: event.target.value.trim().toLowerCase() }))} onBlur={(event) => update({ engineerAzureRegion: event.target.value.trim().toLowerCase().replace(/[^a-z0-9]/g, "") })} placeholder="westeurope" className={selectClass + " font-mono"} />
              </div>
            </div>
            <p className="text-xs text-app-text-muted">{azureKeySet && draft.engineerAzureRegion ? m.engineer_azure_active() : m.engineer_azure_inactive()}</p>
          </div>

          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="engineer-provider" className="mb-1 block text-xs text-app-text-muted">{m.engineer_provider_label()}</Label>
              <select
                id="engineer-provider"
                className={selectClass}
                value={provider}
                onChange={(event) => {
                  const next = event.target.value as EngineerDraft["engineerProvider"];
                  update({ engineerProvider: next, engineerModel: defaultModelForProvider(next) });
                }}
              >
                <option value="">{m.engineer_provider_chat()}</option>
                {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
            {provider !== "" && (
              <div>
                <Label htmlFor="engineer-model" className="mb-1 block text-xs text-app-text-muted">{m.ai_model_label()}</Label>
                <AiModelPicker id="engineer-model" value={draft.engineerModel} onChange={(value) => update({ engineerModel: value })} models={models} />
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
