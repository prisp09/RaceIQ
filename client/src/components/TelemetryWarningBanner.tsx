import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

type TelemetryWarning = { code: "f1-udp-format"; format: number; supported: number };

const DISMISSED_KEY = "raceiq-telemetry-warning-dismissed";

function isDismissed(code: string): boolean {
  try { return localStorage.getItem(`${DISMISSED_KEY}:${code}`) === "1"; } catch { return false; }
}

/** Telemetry problems the server can see but the driver can't, e.g. F1 sending a UDP format RaceIQ doesn't read. */
export function TelemetryWarningBanner() {
  const [warning, setWarning] = useState<TelemetryWarning | null>(null);
  // Hidden for the rest of this app session once closed.
  const [closed, setClosed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const onWarning = (event: Event) => {
      const detail = (event as CustomEvent<TelemetryWarning>).detail;
      if (detail?.code === "f1-udp-format" && !isDismissed(detail.code)) setWarning(detail);
    };
    window.addEventListener("raceiq-telemetry-warning", onWarning);
    return () => window.removeEventListener("raceiq-telemetry-warning", onWarning);
  }, []);

  if (!warning || closed.has(warning.code)) return null;
  const close = () => setClosed((current) => new Set(current).add(warning.code));
  const dontShowAgain = () => {
    try { localStorage.setItem(`${DISMISSED_KEY}:${warning.code}`, "1"); } catch { /* still closes for this session */ }
    close();
  };

  return (
    <div role="alert" className="fixed bottom-4 left-1/2 z-50 flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-lg border border-status-warning/40 bg-app-surface p-3 text-sm shadow-lg">
      <div className="flex-1 space-y-2">
        <p className="text-app-text">{m.telemetry_warning_f1_format({ format: String(warning.format), supported: String(warning.supported) })}</p>
        <Button variant="app-ghost" size="app-sm" onClick={dontShowAgain}>{m.telemetry_warning_dont_show()}</Button>
      </div>
      <Button variant="app-ghost" size="icon-sm" onClick={close} aria-label={m.telemetry_warning_close()}>
        <X className="size-4" />
      </Button>
    </div>
  );
}
