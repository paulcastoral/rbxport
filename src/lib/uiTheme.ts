/**
 * GridBin's look. "machine" (the default) is the drum-machine theme in
 * `styles/machine.css`; "classic" is rbxport's own rekordbox-measured look.
 * Kept in localStorage so it holds across launches; set it from the
 * developer console with `localStorage.setItem("gridbin.theme", "classic")`
 * until Preferences has a switch.
 */
export type UiTheme = "machine" | "classic";

const KEY = "gridbin.theme";

export function storedTheme(): UiTheme {
  try {
    return localStorage.getItem(KEY) === "classic" ? "classic" : "machine";
  } catch {
    return "machine";
  }
}

export function applyTheme(theme: UiTheme = storedTheme()): void {
  if (theme === "machine") document.documentElement.dataset.theme = "machine";
  else delete document.documentElement.dataset.theme;
}

export function setTheme(theme: UiTheme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be off; the theme still applies for this session.
  }
  applyTheme(theme);
}
