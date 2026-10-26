import { useEffect, useRef, useState } from "react";
import { Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { EngineerRadio } from "./EngineerRadio";

/** Shared between the main app and the pop-out so only one of them owns speech and the mic. */
const CHANNEL = "raceiq-engineer-window";
const POPUP_NAME = "raceiq-engineer-radio";
const POPUP_FEATURES = "popup=yes,width=440,height=720";

function openChannel(): BroadcastChannel | null {
  try { return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL); } catch { return null; }
}

/** Bottom-left engineer drawer that can pop out into its own window. */
export function EngineerDrawer() {
  const [poppedOut, setPoppedOut] = useState(false);
  const popup = useRef<Window | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    const bc = openChannel();
    channel.current = bc;
    if (!bc) return;
    bc.onmessage = (event) => {
      if (event.data === "open") setPoppedOut(true);
      else if (event.data === "closed") setPoppedOut(false);
    };
    // A pop-out left open from before a reload answers with "open".
    bc.postMessage("ping");
    return () => { bc.close(); channel.current = null; };
  }, []);

  useEffect(() => {
    if (!poppedOut) return;
    const timer = setInterval(() => {
      if (popup.current?.closed) { popup.current = null; setPoppedOut(false); }
    }, 1000);
    return () => clearInterval(timer);
  }, [poppedOut]);

  const popOut = () => {
    const opened = window.open("/engineer-radio", POPUP_NAME, POPUP_FEATURES);
    if (!opened) return;
    popup.current = opened;
    setPoppedOut(true);
  };

  const bringBack = () => {
    channel.current?.postMessage("close-request");
    popup.current?.close();
    popup.current = null;
    setPoppedOut(false);
  };

  if (!poppedOut) return <EngineerRadio onPopOut={popOut} />;
  return (
    <div className="pointer-events-none absolute bottom-[max(1rem,env(safe-area-inset-bottom,0px))] left-[max(1rem,env(safe-area-inset-left,0px))] z-40">
      <div className="pointer-events-auto flex items-center gap-2 rounded border border-app-border-input bg-app-surface-alt px-3 py-2 text-xs text-app-text shadow-lg">
        <Radio className="size-4 text-app-text-muted" aria-hidden="true" />
        <span>{m.engineer_popped_out()}</span>
        <Button variant="app-ghost" size="app-sm" onClick={bringBack}>{m.engineer_bring_back()}</Button>
      </div>
    </div>
  );
}

/** Mounted in the pop-out window: announces itself so the main app hides its drawer. */
export function EngineerWindowBeacon() {
  useEffect(() => {
    const bc = openChannel();
    if (!bc) return;
    bc.postMessage("open");
    bc.onmessage = (event) => {
      if (event.data === "ping") bc.postMessage("open");
      else if (event.data === "close-request") window.close();
    };
    const announceClosed = () => bc.postMessage("closed");
    window.addEventListener("pagehide", announceClosed);
    return () => {
      announceClosed();
      window.removeEventListener("pagehide", announceClosed);
      bc.close();
    };
  }, []);
  return null;
}

/** Fills the screen with the pop-out window; a second press restores the chat size. */
export function maximizeWindow(): void {
  const maximised = window.outerWidth >= screen.availWidth - 16 && window.outerHeight >= screen.availHeight - 16;
  try {
    if (maximised) {
      window.resizeTo(440, 720);
      return;
    }
    window.moveTo(0, 0);
    window.resizeTo(screen.availWidth, screen.availHeight);
  } catch {
    // Some browsers block resizing; fall back to fullscreen below.
  }
  setTimeout(() => {
    if (window.outerWidth < screen.availWidth - 16 && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, 200);
}
