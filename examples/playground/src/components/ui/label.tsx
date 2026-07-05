import type { LabelHTMLAttributes } from "react";

export function Label({
  className,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={["text-sm font-medium text-slate-700", className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}
