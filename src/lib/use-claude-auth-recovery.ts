import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { terminalEventId } from "./terminal-warmup";

const LOGIN_COMMAND = `/bin/sh -c 'claude auth login; code=$?; printf "\\n__KERN_CLAUDE_LOGIN_EXIT__:%s\\n" "$code"'\r`;

// Claude credentials are shared across chats. Only one browser login may run.
let activeLogin: symbol | null = null;

export function isClaudeLoginExpired(
  harness: string | undefined,
  error: string,
) {
  return (
    harness === "claude-code" &&
    /oauth (?:session|token) (?:has )?expired|login expired|expired (?:oauth|authentication|login)|authentication token.*expired/i.test(
      error,
    )
  );
}

export function useClaudeAuthRecovery(options: {
  chatId: string;
  cwd: string;
  onAuthenticated: () => void | Promise<void>;
  onToast: (message: string) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const attempted = useRef(false);
  const cancel = useRef<(() => void) | null>(null);
  const terminalKey = useRef<string | null>(null);
  const [terminal, setTerminal] = useState<{
    chatId: string;
    cwd: string;
  } | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(
    () => () => {
      cancel.current?.();
      if (terminalKey.current)
        void invoke("terminal_close", { chatId: terminalKey.current }).catch(
          () => {},
        );
    },
    [],
  );

  const recover = useCallback(
    (harness: string | undefined, error: string, retry = false) => {
      if (!isClaudeLoginExpired(harness, error)) return false;
      if (cancel.current || (!retry && attempted.current)) {
        if (retry) setVisible(true);
        return true;
      }
      if (activeLogin) {
        latest.current.onToast(
          "Claude sign-in is already open in another chat.",
        );
        return true;
      }
      attempted.current = true;
      const owner = Symbol();
      activeLogin = owner;
      // A fresh, separate PTY never writes into a user's busy project terminal.
      const chatId = `${latest.current.chatId}__claude_login_${crypto.randomUUID()}`;
      const key = `${chatId}__0`;
      if (terminalKey.current)
        void invoke("terminal_close", { chatId: terminalKey.current }).catch(
          () => {},
        );
      terminalKey.current = key;
      const cwd = latest.current.cwd;
      const unlisteners: Array<() => void> = [];
      let done = false;
      let tail = "";
      let timer: ReturnType<typeof setTimeout>;
      const finish = (success: boolean, error?: string, close = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unlisteners.forEach((unlisten) => unlisten());
        if (activeLogin === owner) activeLogin = null;
        cancel.current = null;
        if (close || success) {
          terminalKey.current = null;
          void invoke("terminal_close", { chatId: key }).catch(() => {});
        }
        if (success) {
          setVisible(false);
          setTerminal(null);
          latest.current.onToast("Claude signed in — reconnecting the agent.");
          void Promise.resolve(latest.current.onAuthenticated()).catch(
            (reason) =>
              latest.current.onToast(
                `Claude reconnect failed: ${String(reason)}`,
              ),
          );
        } else if (error) latest.current.onToast(error);
      };
      cancel.current = () => finish(false, undefined, true);
      timer = setTimeout(
        () =>
          finish(
            false,
            "Claude sign-in timed out. Try signing in again.",
            true,
          ),
        10 * 60_000,
      );

      // Subscribe before starting the command, including when output is replayed
      // by the terminal UI. Only an actual exit code permits reconnecting.
      void (async () => {
        const subscribe = async (
          event: string,
          handler: (data: string) => void,
        ) => {
          const unlisten = await listen<string>(event, (e) =>
            handler(e.payload),
          );
          if (done) unlisten();
          else unlisteners.push(unlisten);
        };
        await subscribe(`terminal://data/${terminalEventId(key)}`, (data) => {
          tail = (tail + data).slice(-4096);
          const match = tail.match(
            /(?:^|[\r\n])__KERN_CLAUDE_LOGIN_EXIT__:(\d+)(?:[\r\n])/,
          );
          if (match)
            finish(
              match[1] === "0",
              "Claude sign-in did not complete. Check the login terminal, then try again.",
            );
        });
        if (done) return;
        await subscribe(`terminal://exit/${terminalEventId(key)}`, () => {
          finish(false, "Claude sign-in was closed before it completed.");
        });
        if (done) return;
        await invoke("terminal_open", {
          chatId: key,
          cwd,
          cols: 120,
          rows: 32,
        });
        if (done) {
          await invoke("terminal_close", { chatId: key }).catch(() => {});
          return;
        }
        setTerminal({ chatId, cwd });
        setVisible(true);
        latest.current.onToast("Claude login expired — opening sign-in.");
        await invoke("terminal_write", { chatId: key, data: LOGIN_COMMAND });
      })().catch((error) =>
        finish(false, `Claude sign-in failed: ${String(error)}`, true),
      );
      return true;
    },
    [],
  );

  // A successful model response starts a new expiry episode. Merely restarting
  // must not clear this guard, or rejected credentials cause a login loop.
  const markHealthy = useCallback(() => {
    if (!cancel.current) attempted.current = false;
  }, []);

  return {
    recover,
    markHealthy,
    terminal,
    visible,
    hide: () => setVisible(false),
  };
}
