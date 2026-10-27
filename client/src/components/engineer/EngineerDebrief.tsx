import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authenticatedFetch } from "@/lib/rpc";
import { m } from "@/paraglide/messages";

type Debrief = { debrief: string; finalPosition: number | null; calls: { at: string; text: string }[]; createdAt: string };

/** The race engineer's saved end-of-session debrief and key radio calls for one session; renders nothing when there is none. */
export function EngineerDebrief({ sessionId }: { sessionId: number }) {
  const [showCalls, setShowCalls] = useState(false);
  const query = useQuery({
    queryKey: ["engineer-debrief", sessionId],
    queryFn: async (): Promise<Debrief | null> => {
      const res = await authenticatedFetch(`/api/engineer/debrief/${sessionId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Engineer debrief request failed (${res.status})`);
      return await res.json() as Debrief;
    },
  });
  const debrief = query.data;
  if (!debrief) return null;
  return (
    <section className="col-span-full border-t border-app-border px-4 py-3" aria-label={m.engineer_debrief_title()}>
      <div className="mb-1.5 flex items-center gap-2">
        <Radio className="size-3.5 text-app-text-muted" aria-hidden="true" />
        <span className="text-app-compact font-semibold uppercase tracking-wider text-app-text-muted">{m.engineer_debrief_title()}</span>
        {debrief.finalPosition != null && debrief.finalPosition > 0 && <span className="text-app-compact text-app-text-muted">{m.engineer_debrief_position({ position: debrief.finalPosition })}</span>}
      </div>
      <p className="max-w-3xl text-sm text-app-text">{debrief.debrief}</p>
      {debrief.calls.length > 0 && (
        <div className="mt-2">
          <Button variant="app-ghost" size="app-sm" onClick={() => setShowCalls((value) => !value)} aria-expanded={showCalls}>
            {showCalls ? <ChevronUp className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
            {m.engineer_debrief_calls({ count: debrief.calls.length })}
          </Button>
          {showCalls && (
            <ol className="mt-1 flex max-w-3xl flex-col gap-1 text-xs text-app-text">
              {debrief.calls.map((call) => (
                <li key={`${call.at}-${call.text}`} className="flex gap-2">
                  <time className="shrink-0 tabular-nums text-app-text-muted" dateTime={call.at}>{new Date(call.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                  <span>{call.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
