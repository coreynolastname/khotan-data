import type { InputHTMLAttributes } from "react";

interface SwitchProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "type"
> {
  onCheckedChange?: (checked: boolean) => void;
}

export function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: SwitchProps) {
  return (
    <input
      checked={checked}
      className={className}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      type="checkbox"
      {...props}
    />
  );
}
