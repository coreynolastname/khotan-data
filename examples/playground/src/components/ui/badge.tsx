import type { HTMLAttributes } from "react";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "secondary" | "destructive" | "outline";
}

export function Badge({
  className,
  variant = "default",
  ...props
}: BadgeProps) {
  const classes = [
    "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium",
    variant === "secondary" ? "bg-slate-100 text-slate-700" : "",
    variant === "destructive" ? "border-red-300 bg-red-50 text-red-700" : "",
    variant === "outline" ? "bg-white text-slate-700" : "",
    variant === "default" ? "border-slate-900 bg-slate-900 text-white" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <span className={classes} {...props} />;
}
