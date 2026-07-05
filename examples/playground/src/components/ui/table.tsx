import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

type TableProps = HTMLAttributes<HTMLTableElement>;
type SectionProps = HTMLAttributes<HTMLTableSectionElement>;
type RowProps = HTMLAttributes<HTMLTableRowElement>;

export function Table({ className, ...props }: TableProps) {
  return (
    <table
      className={["w-full border-collapse text-sm", className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}

export function TableHeader(props: SectionProps) {
  return <thead {...props} />;
}

export function TableBody(props: SectionProps) {
  return <tbody {...props} />;
}

export function TableRow(props: RowProps) {
  return <tr {...props} />;
}

export function TableHead({
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={["border-b px-3 py-2 text-left font-medium", className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}

export function TableCell({
  className,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={["border-b px-3 py-2", className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}
