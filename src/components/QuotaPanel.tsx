import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "./ConfirmDialog";
import {
  formatReset,
  quotaSnapshot,
  refreshQuota,
  subscribeQuota,
  type QuotaAccount,
  type QuotaSnapshot,
} from "../lib/quota";

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
  onReset,
}: {
  account: QuotaAccount;
  busy: boolean;
  onReset: (account: QuotaAccount) => void;
}) {
  return (
    <section className="kq-account" aria-label={account.name}>
      <header>
        <strong title={account.name}>{account.name}</strong>
        <small>
          {[account.provider, account.plan].filter(Boolean).join(" · ")}
        </small>
      </header>
      {account.error && (
        <p className="kq-error" role="alert">
          {account.error}
        </p>
      )}
      {account.windows.map((window) => (
        <div className="kq-window" key={window.label}>
          <div className="kq-window-text">
            <span>{window.label}</span>
            <span>{Math.round(window.used_percent)}% used</span>
          </div>
          <div
            className={`kq-bar${severity(window.used_percent)}`}
            role="meter"
            aria-label={`${account.name} ${window.label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(window.used_percent)}
          >
            <span style={{ width: `${Math.min(100, window.used_percent)}%` }} />
          </div>
          {window.resets_at && <small>{formatReset(window.resets_at)}</small>}
        </div>
      ))}
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
      {groups(snapshot?.accounts ?? []).map(([group, accounts]) => (
        <div className="kq-group" key={group}>
          <h4>{group}</h4>
          {accounts.map((account) => (
            <Account
              key={account.id}
              account={account}
              busy={resetting === account.id}
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
