import "../terminal.css";

/*
 * Terminal start-up work that does not need a PTY: the ghostty-web module and
 * its WASM core, plus the fonts the canvas measures. Doing it ahead of time
 * (when a chat becomes idle) makes opening the terminal near-instant, and
 * loading fonts before the first measure keeps the cell grid aligned.
 */

// Nerd Font variants users commonly install first, then the bundled
// JetBrains Mono, then the bundled symbols-only Nerd Font so prompt icons
// (powerline, git, folder glyphs) render even without a patched font.
export const TERMINAL_FONT_FAMILY = [
  "'JetBrainsMono Nerd Font'",
  "'JetBrainsMono NF'",
  "'MesloLGS NF'",
  "'MesloLGS Nerd Font'",
  "'Hack Nerd Font'",
  "'FiraCode Nerd Font'",
  "'JetBrains Mono'",
  "'Kern Symbols Nerd Font'",
  "'SF Mono'",
  "Menlo",
  "monospace",
].join(", ");

export const TERMINAL_FONT_SIZE = 13;

/**
 * Tauri event names allow only `[A-Za-z0-9-/:_]`, but chat ids may contain
 * e.g. dots ("deployment-3.0"). Every other UTF-8 byte (and `:` itself)
 * becomes `:HH`. Must match `event_id` in src-tauri/src/terminal.rs.
 */
export function terminalEventId(sessionKey: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(sessionKey)) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-/_]/.test(ch)
      ? ch
      : `:${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

let warm: Promise<void> | null = null;

async function loadFonts() {
  const fonts = document.fonts;
  if (!fonts) return;
  const size = `${TERMINAL_FONT_SIZE}px`;
  await Promise.all([
    fonts.load(`${size} 'JetBrains Mono'`),
    fonts.load(
      `${size} 'Kern Symbols Nerd Font'`,
      // powerline arrow + git branch: forces the symbols font to download
      String.fromCodePoint(0xe0b0, 0xf418),
    ),
  ]).catch(() => undefined);
}

export function warmTerminal(): Promise<void> {
  warm ??= (async () => {
    const [{ init }] = await Promise.all([import("ghostty-web"), loadFonts()]);
    await init();
  })().catch((error) => {
    warm = null; // allow a retry on the next open
    throw error;
  });
  return warm;
}

/** Warm up once the browser is idle, without competing with first paint. */
export function warmTerminalWhenIdle() {
  const run = () => void warmTerminal().catch(() => undefined);
  const idle = (
    window as Window & {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => number;
    }
  ).requestIdleCallback;
  if (idle) idle(run, { timeout: 3000 });
  else window.setTimeout(run, 1200);
}
