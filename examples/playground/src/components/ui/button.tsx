import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "secondary" | "destructive" | "outline" | "ghost";
  size?: "default" | "sm" | "lg";
}

export function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  const classes = [
    "inline-flex items-center justify-center rounded border font-medium transition disabled:opacity-50",
    size === "sm" ? "h-8 px-3 text-sm" : "",
    size === "lg" ? "h-11 px-5" : "",
    size === "default" ? "h-9 px-4 text-sm" : "",
    variant === "default" ? "border-slate-900 bg-slate-900 text-white" : "",
    variant === "secondary"
      ? "border-slate-200 bg-slate-100 text-slate-900"
      : "",
    variant === "destructive" ? "border-red-600 bg-red-600 text-white" : "",
    variant === "outline" ? "border-slate-300 bg-white text-slate-900" : "",
    variant === "ghost"
      ? "border-transparent bg-transparent text-slate-900"
      : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <button className={classes} {...props} />;
}
