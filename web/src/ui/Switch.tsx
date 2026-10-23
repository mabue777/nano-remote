// An on/off switch: a 52 x 32 track with a knob, inside a 44 px touch target. It is a button with
// role="switch" and aria-checked; the label is the element that `labelledBy` names. Styles: .switch in
// styles/components.css (the look follows aria-checked).

export interface SwitchProps {
  checked: boolean;
  /** Called with the new value on a tap. */
  onChange: (checked: boolean) => void;
  /** id of the element that labels the switch. */
  labelledBy: string;
  /** id of a status line that describes the current state. */
  describedBy?: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, labelledBy, describedBy, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span class="knob" aria-hidden="true" />
    </button>
  );
}
