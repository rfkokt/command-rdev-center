import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "./ConfirmDialog";
import { PinIcon } from "./ui-icons";
import {
  formatReset,
  quotaSnapshot,
  refreshQuota,
  subscribeQuota,
  type QuotaAccount,
  type QuotaSnapshot,
} from "../lib/quota";

const PINNED_ACCOUNTS_KEY = "crc:quota-pinned:v1";
const PINNED_ACCOUNTS_EVENT = "crc:quota-pinned-changed";
const VISIBLE_QUOTAS = 5;

function readPinnedAccounts(): string[] {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(PINNED_ACCOUNTS_KEY) ?? "[]",
    );
    return Array.isArray(saved)
      ? saved.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function providerName(provider: string) {
  const names: Record<string, string> = {
    claude: "Claude",
    codex: "OpenAI Codex",
    antigravity: "Antigravity",
    glm: "GLM",
  };
  return names[provider] ?? provider;
}

/** Accounts grouped by source, in first-seen order. */
function groups(accounts: QuotaAccount[]): Array<[string, QuotaAccount[]]> {
  const map = new Map<string, QuotaAccount[]>();
  for (const account of accounts)
    map.set(account.group, [...(map.get(account.group) ?? []), account]);
  return [...map.entries()];
}

function severity(percent: number) {
  if (percent >= 90) return " is-critical";
  if (percent >= 70) return " is-high";
  return "";
}

function Account({
  account,
  busy,
  pinned,
  onPin,
  onReset,
}: {
  account: QuotaAccount;
  busy: boolean;
  pinned: boolean;
  onPin: (id: string) => void;
  onReset: (account: QuotaAccount) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const windowsId = useId();
  const windows = [...account.windows].sort(
    (left, right) => right.used_percent - left.used_percent,
  );
  const visibleWindows = expanded ? windows : windows.slice(0, VISIBLE_QUOTAS);
  const pinLabel = `${pinned ? "Unpin" : "Pin"} ${account.name} (${account.group})`;

  return (
    <section
      className={`kq-account${pinned ? " is-pinned" : ""}`}
      aria-label={account.name}
    >
      <header>
        <span className="kq-provider-mark" aria-hidden="true">
          {providerName(account.provider).slice(0, 1)}
        </span>
        <div className="kq-account-title">
          <strong>{providerName(account.provider)}</strong>
          <small
            title={[account.name, account.plan, account.group]
              .filter(Boolean)
              .join(" · ")}
          >
            {[account.name, account.plan].filter(Boolean).join(" · ")}
          </small>
        </div>
        <button
          type="button"
          className="kq-pin"
          aria-label={pinLabel}
          aria-pressed={pinned}
          title={pinLabel}
          onClick={() => onPin(account.id)}
        >
          <PinIcon size={14} />
        </button>
      </header>
      {account.error && (
        <p className="kq-error" role="alert">
          {account.error}
        </p>
      )}
      <div className="kq-account-meta">
        <span>
          {account.windows.length}{" "}
          {account.windows.length === 1 ? "quota" : "quotas"}
        </span>
        {pinned && <span title={account.group}>{account.group}</span>}
      </div>
      <div className="kq-windows" id={windowsId}>
        {visibleWindows.map((window) => {
          const used = Math.max(0, Math.min(100, window.used_percent));
          const remaining = 100 - used;
          const reset = formatReset(window.resets_at);
          return (
            <div className={`kq-window${severity(used)}`} key={window.label}>
              <span className="kq-window-label" title={window.label}>
                <i aria-hidden="true" />
                {window.label}
              </span>
              <div className="kq-window-detail">
                <div
                  className={`kq-bar${severity(used)}`}
                  role="meter"
                  aria-label={`${account.name} ${window.label} remaining`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(remaining)}
                  aria-valuetext={`${Math.round(remaining)}% remaining, ${Math.round(used)}% used`}
                >
                  <span style={{ width: `${remaining}%` }} />
                </div>
                <div className="kq-window-meta">
                  <small title={reset}>
                    {reset ? reset.replace(/^resets /, "") : "—"}
                  </small>
                  <span title={`${Math.round(used)}% used`}>
                    {Math.round(remaining)}% left
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {windows.length > VISIBLE_QUOTAS && (
        <button
          type="button"
          className="kq-more"
          aria-expanded={expanded}
          aria-controls={windowsId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? "Show fewer quotas"
            : `Show ${windows.length - VISIBLE_QUOTAS} more quotas`}
        </button>
      )}
      {account.note && <p className="kq-note">{account.note}</p>}
      {account.reset_credits > 0 && (
        <button
          type="button"
          className="kq-reset"
          disabled={busy}
          onClick={() => onReset(account)}
        >
          {busy
            ? "Resetting…"
            : `Use reset credit (${account.reset_credits} left)`}
        </button>
      )}
    </section>
  );
}

/** Subscription quota per account (Claude login + 9router connections). */
export default function QuotaPanel({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot | null>(quotaSnapshot);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const [pinnedIds, setPinnedIds] = useState(readPinnedAccounts);
  const pinned = new Set(pinnedIds);
  const accounts = snapshot?.accounts ?? [];
  const pinnedAccounts = accounts.filter((account) => pinned.has(account.id));
  const accountGroups = groups(
    accounts.filter((account) => !pinned.has(account.id)),
  );
  const sections = [
    ...(pinnedAccounts.length
      ? [{ key: "pinned", title: "Pinned", accounts: pinnedAccounts }]
      : []),
    ...accountGroups.map(([group, groupAccounts]) => ({
      key: `group:${group}`,
      title: group,
      accounts: groupAccounts,
    })),
  ];

  useEffect(() => {
    const syncPins = (event: Event) => {
      if (event instanceof CustomEvent) setPinnedIds(event.detail as string[]);
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key === PINNED_ACCOUNTS_KEY || event.key === null)
        setPinnedIds(readPinnedAccounts());
    };
    window.addEventListener(PINNED_ACCOUNTS_EVENT, syncPins);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(PINNED_ACCOUNTS_EVENT, syncPins);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  function togglePin(id: string) {
    const next = pinned.has(id)
      ? pinnedIds.filter((pinnedId) => pinnedId !== id)
      : [...pinnedIds, id];
    setPinnedIds(next);
    try {
      localStorage.setItem(PINNED_ACCOUNTS_KEY, JSON.stringify(next));
    } catch {
      onToast("Pin preference kept for this session; couldn't save it.");
    }
    window.dispatchEvent(
      new CustomEvent(PINNED_ACCOUNTS_EVENT, { detail: next }),
    );
  }

  async function reload(force: boolean) {
    setLoading(true);
    try {
      await refreshQuota(force);
    } catch (e) {
      onToast(`Couldn't load quota: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const unsubscribe = subscribeQuota(setSnapshot);
    // Opening the panel refreshes unless the poller just did (backend cache).
    void refreshQuota(false).catch(() => {});
    return unsubscribe;
  }, []);

  async function reset(account: QuotaAccount) {
    const ok = await confirm({
      title: "Use reset credit?",
      message: `This spends one of ${account.name}'s ${account.reset_credits} reset credit(s) and resets its 5-hour and weekly limits now. It can't be undone.`,
      confirmLabel: "Reset limits",
    });
    if (!ok) return;
    setResetting(account.id);
    try {
      const message = await invoke<string>("redeem_quota_reset", {
        accountId: account.id,
      });
      onToast(`${account.name}: ${message}`);
      await refreshQuota(true);
    } catch (e) {
      onToast(`Couldn't reset ${account.name}: ${String(e)}`);
    } finally {
      setResetting(null);
    }
  }

  return (
    <div className="kq">
      <div className="kq-toolbar">
        <small>
          {snapshot
            ? `Checked ${new Date(snapshot.checked_at * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
            : "Loading…"}
        </small>
        <button
          type="button"
          disabled={loading}
          onClick={() => void reload(true)}
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>
      {sections.map(({ key, title, accounts: groupAccounts }) => (
        <div className="kq-group" key={key}>
          <h4>{title}</h4>
          {groupAccounts.map((account) => (
            <Account
              key={account.id}
              account={account}
              busy={resetting === account.id}
              pinned={pinned.has(account.id)}
              onPin={togglePin}
              onReset={(item) => void reset(item)}
            />
          ))}
        </div>
      ))}
      {snapshot && snapshot.accounts.length === 0 && (
        <p className="kq-note">No quota sources are on.</p>
      )}
      {snapshot && snapshot.routers === 0 && (
        <p className="kq-note">
          Add your 9routers in Settings → Agent harness to see every connected
          account and use reset credits.
        </p>
      )}
    </div>
  );
}
