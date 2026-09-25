export function initials(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase() || "?";
}

export function shortDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function fullDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Ohne Datum"
    : date.toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
}

export function time(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}
