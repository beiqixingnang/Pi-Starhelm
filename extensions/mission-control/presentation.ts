import type { Theme, ThemeBg } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type UiTheme = Partial<
  Pick<Theme, "fg" | "bg" | "bold" | "italic" | "strikethrough" | "underline">
>;

/** Match Pi's padded message panels without adding a border to selectable text. */
export function panelLine(
  text: string,
  width: number,
  background: ThemeBg | undefined,
  theme?: UiTheme,
) {
  const line = truncateToWidth(text, Math.max(1, width));
  if (!background || !theme?.bg) return line;
  const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
  const marker = "x";
  const sample = theme.bg(background, marker);
  const markerIndex = sample.indexOf(marker);
  if (markerIndex < 0) return padded;
  const start = sample.slice(0, markerIndex);
  const end = sample.slice(markerIndex + marker.length);
  const parts = padded.split(/(\x1b\[[0-?]*[ -/]*m)/g);
  let painted = start;
  for (const part of parts)
    painted += /^\x1b\[[0-?]*[ -/]*m$/.test(part)
      ? part + start
      : part;
  return painted + end;
}
