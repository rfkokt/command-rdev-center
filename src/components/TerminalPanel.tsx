import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { init, Terminal, FitAddon } from "ghostty-web";

// One PTY terminal, bound to a backend session key. Kill on unmount only when asked.
function TerminalPane({ sessionKey, cwd, onKilled, onUrl }: { sessionKey: string; cwd: string; onKilled: () => void; onUrl?: (url: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const unlisten: Array<() => void> = [];
    const cleanup: { term?: Terminal } = {};
    let disposed = false;

    (async () => {
      await init();
      if (disposed) return;
      const fontFamily = "'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, monospace";
      const term = new Terminal({ fontSize: 13, fontFamily, cursorBlink: true, theme: { background: "#0b0e14" } });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      cleanup.term = term;

      // register the output listener BEFORE spawning so the first shell prompt isn't lost
      await listen<string>(`terminal://data/${sessionKey}`, (e) => {
        term.write(e.payload);
        for (const url of e.payload.match(/https?:\/\/[^\s<>"']+/g) || []) onUrl?.(url);
      }).then((u) => unlisten.push(u));
      await listen(`terminal://exit/${sessionKey}`, () => term.write("\r\n[process exited]\r\n")).then((u) => unlisten.push(u));

      term.onResize(({ cols, rows }) => void invoke("terminal_resize", { chatId: sessionKey, cols, rows }).catch(() => {}));

      // spawn the shell first so the prompt is never blocked on font/layout work
      const snapshot = await invoke<string>("terminal_open", { chatId: sessionKey, cwd, cols: term.cols, rows: term.rows }).catch((err) => { term.write(`\r\nterminal error: ${String(err)}\r\n`); return ""; });
      if (disposed) return;
      if (snapshot) term.write(snapshot);
      term.onData((data) => void invoke("terminal_write", { chatId: sessionKey, data }).catch(() => {}));

      // fit once the font+layout settle; guarded with a timeout so a stuck fonts.ready never blocks the shell
      const settle = Promise.all([
        document.fonts?.load("13px 'JetBrainsMono Nerd Font'").catch(() => {}) ?? Promise.resolve(),
        document.fonts?.ready ?? Promise.resolve(),
      ]);
      await Promise.race([settle, new Promise((r) => setTimeout(r, 400))]);
      if (disposed) return;
      (term as unknown as { renderer?: { remeasureFont(): void } }).renderer?.remeasureFont();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (disposed) return;
      fit.fit();
      fit.observeResize();
    })().catch((error) => {
      if (!disposed) host.textContent = `Terminal failed to initialize: ${String(error)}`;
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
        <button className="term-icon-btn danger" title="Kill this terminal" aria-label="Kill terminal" onClick={() => { void invoke("terminal_close", { chatId: sessionKey }).catch(() => {}); onKilled(); }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
        </button>
      </div>
      <div ref={hostRef} className="terminal-panel-host" />
    </div>
  );
}

// Draggable floating modal hosting one or more split terminal panes for a chat's worktree.
export default function TerminalPanel({ chatId, cwd, hidden, onClose, onUrl }: { chatId: string; cwd: string; hidden?: boolean; onClose: () => void; onUrl?: (url: string) => void }) {
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

  return (
    <div className="terminal-modal" style={{ left: pos.x, top: pos.y, display: hidden ? "none" : "flex" }} role="dialog" aria-label="Terminal">
      <div className="terminal-panel-bar" onPointerDown={onBarPointerDown} onPointerMove={onBarPointerMove} onPointerUp={onBarPointerUp}>
        <span className="terminal-title">{cwd.split("/").pop() || "TERMINAL"}</span>
        <div className="terminal-bar-actions">
          <button className="term-icon-btn" title="New split" onClick={addPane} aria-label="Split terminal">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor"/><line x1="8" y1="5" x2="8" y2="11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
          </button>
          <button className="term-icon-btn" title={vertical ? "Stack vertically" : "Side by side"} onClick={() => setVertical((v) => !v)} aria-label="Toggle split orientation">
            {vertical
              ? <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor"/><line x1="8" y1="2" x2="8" y2="14" stroke="currentColor"/></svg>
              : <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor"/><line x1="2" y1="8" x2="14" y2="8" stroke="currentColor"/></svg>}
          </button>
          <button className="term-icon-btn" title="Hide (keep running)" onClick={onClose} aria-label="Hide terminal">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
          </button>
        </div>
      </div>
      <div className={`terminal-split ${vertical ? "vertical" : "horizontal"}`}>
        {panes.map((idx) => (
          <TerminalPane key={idx} sessionKey={`${chatId}__${idx}`} cwd={cwd} onKilled={() => removePane(idx)} onUrl={onUrl} />
        ))}
      </div>
    </div>
  );
}
