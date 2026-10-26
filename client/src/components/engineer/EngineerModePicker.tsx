import { SearchSelect } from "@/components/ui/SearchSelect";
import { m } from "@/paraglide/messages";

export type EngineerMode = "quiet" | "normal" | "coach" | "co-driver";

function modeOptions() {
  return [
    { value: "quiet", label: m.engineer_mode_quiet(), description: m.engineer_mode_quiet_desc() },
    { value: "normal", label: m.engineer_mode_normal(), description: m.engineer_mode_normal_desc() },
    { value: "coach", label: m.engineer_mode_coach(), description: m.engineer_mode_coach_desc(), badge: m.engineer_mode_uses_ai_tokens() },
    { value: "co-driver", label: m.engineer_mode_codriver(), description: m.engineer_mode_codriver_desc(), badge: m.engineer_mode_uses_ai_tokens() },
  ];
}

/** Radio mode dropdown: names plus one-line descriptions; the closed control shows the name. */
export function EngineerModePicker({ id, value, onChange, className }: { id: string; value: EngineerMode; onChange: (mode: EngineerMode) => void; className?: string }) {
  const options = modeOptions();
  const selected = options.find((option) => option.value === value);
  return (
    <SearchSelect
      id={id}
      value={value}
      onChange={(next) => onChange(next as EngineerMode)}
      options={options}
      ariaLabel={m.engineer_mode_label()}
      title={selected?.description}
      className={className}
    />
  );
}
