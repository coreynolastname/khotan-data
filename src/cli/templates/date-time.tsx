type DateTimeInput = string | number | Date | null | undefined;

interface LocalTimeOptions {
  emptyLabel?: string;
  includeSeconds?: boolean;
  includeTimeZone?: boolean;
}

export function getLocalTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function parseDate(
  value: Exclude<DateTimeInput, null | undefined>,
): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLocalDate(
  value: DateTimeInput,
  options: Intl.DateTimeFormatOptions,
  emptyLabel: string,
): string {
  if (value === null || value === undefined || value === "") {
    return emptyLabel;
  }

  const date = parseDate(value);
  if (!date) return String(value);

  const timeZone = getLocalTimeZone();
  const formatterOptions: Intl.DateTimeFormatOptions = timeZone
    ? { ...options, timeZone }
    : options;

  return new Intl.DateTimeFormat(undefined, formatterOptions).format(date);
}

export function formatLocalDateTime(
  value: DateTimeInput,
  emptyLabel = "Never",
): string {
  return formatLocalDate(
    value,
    {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    },
    emptyLabel,
  );
}

export function formatLocalTime(
  value: DateTimeInput,
  {
    emptyLabel = "Never",
    includeSeconds = false,
    includeTimeZone = true,
  }: LocalTimeOptions = {},
): string {
  return formatLocalDate(
    value,
    {
      hour: "2-digit",
      minute: "2-digit",
      ...(includeSeconds ? { second: "2-digit" as const } : {}),
      ...(includeTimeZone ? { timeZoneName: "short" as const } : {}),
    },
    emptyLabel,
  );
}

export function formatDurationMs(
  value: number | null | undefined,
  emptyLabel = "-",
): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return emptyLabel;
  }

  if (value < 1000) {
    return `${String(Math.round(value))} ms`;
  }

  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) {
    const seconds = value / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : String(totalSeconds)}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return `${String(totalMinutes)}m ${String(seconds).padStart(2, "0")}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours)}h ${String(minutes).padStart(2, "0")}m`;
}
