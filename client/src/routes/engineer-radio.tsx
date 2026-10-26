import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EngineerRadio } from "@/components/engineer/EngineerRadio";
import { EngineerWindowBeacon } from "@/components/engineer/EngineerDrawer";
import { m } from "@/paraglide/messages";

/** Standalone pop-out window for the race engineer radio. */
function EngineerRadioWindow() {
  useEffect(() => { document.title = `${m.engineer_title()} · RaceIQ`; }, []);
  return (
    <div className="h-screen bg-app-bg text-app-text">
      <EngineerWindowBeacon />
      <EngineerRadio variant="window" />
    </div>
  );
}

export const Route = createFileRoute("/engineer-radio")({ component: EngineerRadioWindow });
