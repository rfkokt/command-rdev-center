import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal, FitAddon, type ITheme } from "ghostty-web";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  warmTerminal,
} from "../lib/terminal-warmup";

// Full ANSI palette (One Dark–style, like Zed) so CLI colors match a native
// terminal instead of ghostty-web's defaults.
const TERMINAL_THEME: ITheme = {
  background: "#0b0e14",
  foreground: "#c8ccd4",
  cursor: "#74ade8",
  cursorAccent: "#0b0e14",
  selectionBackground: "#3e4451",
  selectionForeground: "#e6e6e6",
  black: "#3f4451",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#d7dae0",
  brightBlack: "#5c6370",
  brightRed: "#ea858b",
  brightGreen: "#aad581",
  brightYellow: "#f0d197",
  brightBlue: "#85c0f5",
  brightMagenta: "#d398eb",
  brightCyan: "#6ed5de",
  brightWhite: "#ffffff",
};

// One PTY terminal, bound to a backend session key. Kill on unmount only when asked.
function TerminalPane({
  sessionKey,
  cwd,
  onKilled,
  onUrl,
}: {
  sessionKey: string;
  cwd: string;
  onKilled: () => void;
  onUrl?: (url: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const unlisten: Array<() => void> = [];
    const cleanup: { term?: Terminal } = {};
    let disposed = false;

    (async () => {
      // Module, WASM and fonts are usually warm already (see warmTerminal).
      await warmTerminal();
      if (disposed) return;
      const term = new Terminal({
        fontSize: TERMINAL_FONT_SIZE,
        fontFamily: TERMINAL_FONT_FAMILY,
        cursorBlink: true,
        scrollback: 10000,
        theme: TERMINAL_THEME,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      cleanup.term = term;
      // Fit BEFORE spawning: a shell started at the default 80x24 and resized
      // a moment later redraws its prompt and leaves garbled lines behind.
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();

      // register the output listener BEFORE spawning so the first shell prompt isn't lost
      await listen<string>(`terminal://data/${sessionKey}`, (e) => {
        term.write(e.payload);
        for (const url of e.payload.match(/https?:\/\/[^\s<>"']+/g) || [])
          onUrl?.(url);
      }).then((u) => unlisten.push(u));
      await listen(`terminal://exit/${sessionKey}`, () =>
        term.write("\r\n[process exited]\r\n"),
      ).then((u) => unlisten.push(u));
      if (disposed) return;

      term.onResize(
        ({ cols, rows }) =>
          void invoke("terminal_resize", {
            chatId: sessionKey,
            cols,
            rows,
          }).catch(() => {}),
      );

      const snapshot = await invoke<string>("terminal_open", {
        chatId: sessionKey,
        cwd,
        cols: term.cols,
        rows: term.rows,
      }).catch((err) => {
        term.write(`\r\nterminal error: ${String(err)}\r\n`);
        return "";
      });
      if (disposed) return;
      if (snapshot) term.write(snapshot);
      term.onData(
        (data) =>
          void invoke("terminal_write", { chatId: sessionKey, data }).catch(
            () => {},
          ),
      );
      fit.observeResize();
      term.focus();
    })().catch((error) => {
      if (!disposed)
        host.textContent = `Terminal failed to initialize: ${String(error)}`;
    });

    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
      cleanup.term?.dispose();
      // backend session kept alive across remounts; killed explicitly via the pane ✕
    };
  }, [sessionKey, cwd, onUrl]);

  return (
    <div className="terminal-pane">
      <div className="terminal-pane-bar">
        <button
          className="term-icon-btn danger"
          title="Kill this terminal"
          aria-label="Kill terminal"
          onClick={() => {
            void invoke("terminal_close", { chatId: sessionKey }).catch(
              () => {},
            );
            onKilled();
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <line
              x1="4"
              y1="4"
              x2="12"
              y2="12"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
            <line
              x1="12"
              y1="4"
              x2="4"
              y2="12"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div ref={hostRef} className="terminal-panel-host" />
    </div>
  );
}

// Draggable floating modal hosting one or more split terminal panes for a chat's worktree.
export default function TerminalPanel({
  chatId,
  cwd,
  hidden,
  onClose,
  onUrl,
}: {
  chatId: string;
  cwd: string;
  hidden?: boolean;
  onClose: () => void;
  onUrl?: (url: string) => void;
}) {
  const [pos, setPos] = useState(() => ({
    x: Math.max(12, Math.round((window.innerWidth - 760) / 2)),
    y: Math.max(12, Math.round((window.innerHeight - 460) / 2)),
  }));
  const [panes, setPanes] = useState<number[]>([0]); // pane indices → session key chatId#idx
  const [vertical, setVertical] = useState(false); // false = side-by-side, true = stacked
  const nextIdx = useRef(1);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  function onBarPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  }
  function onBarPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy });
  }
  function onBarPointerUp() {
    drag.current = null;
  }

  function addPane() {
    setPanes((p) => [...p, nextIdx.current++]);
  }
  function removePane(idx: number) {
    setPanes((p) => {
      if (p.length > 1) return p.filter((i) => i !== idx);
      // killed the last pane: replace with a fresh (un-spawned) index; hide happens below
      return [nextIdx.current++];
    });
    if (panes.length <= 1) onClose();
  }

  // Portaled to <body>: inside the chat view the modal sat in a z-index:1
  // stacking context, so the sidebar (z-index:30) covered its left edge.
  return createPortal(
    <div
      className="terminal-modal"
      style={{ left: pos.x, top: pos.y, display: hidden ? "none" : "flex" }}
      role="dialog"
      aria-label="Terminal"
    >
      <div
        className="terminal-panel-bar"
        onPointerDown={onBarPointerDown}
        onPointerMove={onBarPointerMove}
        onPointerUp={onBarPointerUp}
      >
        <span className="terminal-title">
          {cwd.split("/").pop() || "TERMINAL"}
        </span>
        <div className="terminal-bar-actions">
          <button
            className="term-icon-btn"
            title="New split"
            onClick={addPane}
            aria-label="Split terminal"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <rect
                x="1.5"
                y="1.5"
                width="13"
                height="13"
                rx="1.5"
                stroke="currentColor"
              />
              <line
                x1="8"
                y1="5"
                x2="8"
                y2="11"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
              <line
                x1="5"
                y1="8"
                x2="11"
                y2="8"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            className="term-icon-btn"
            title={vertical ? "Stack vertically" : "Side by side"}
            onClick={() => setVertical((v) => !v)}
            aria-label="Toggle split orientation"
          >
            {vertical ? (
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <rect
                  x="1.5"
                  y="1.5"
                  width="13"
                  height="13"
                  rx="1.5"
                  stroke="currentColor"
                />
                <line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <rect
                  x="1.5"
                  y="1.5"
                  width="13"
                  height="13"
                  rx="1.5"
                  stroke="currentColor"
                />
                <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" />
              </svg>
            )}
          </button>
          <button
            className="term-icon-btn"
            title="Hide (keep running)"
            onClick={onClose}
            aria-label="Hide terminal"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <line
                x1="3"
                y1="8"
                x2="13"
                y2="8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <div className={`terminal-split ${vertical ? "vertical" : "horizontal"}`}>
        {panes.map((idx) => (
          <TerminalPane
            key={idx}
            sessionKey={`${chatId}__${idx}`}
            cwd={cwd}
            onKilled={() => removePane(idx)}
            onUrl={onUrl}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}
