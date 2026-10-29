import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "./ConfirmDialog";
import { PinIcon } from "./ui-icons";
import {
  formatReset,
  orderedQuotaWindows,
  providerName,
  quotaSnapshot,
  readPinnedAccounts,
  refreshQuota,
  subscribePinnedAccounts,
  subscribeQuota,
  writePinnedAccounts,
  type QuotaAccount,
  type QuotaSnapshot,
} from "../lib/quota";

const VISIBLE_QUOTAS = 5;
const FLOAT_ENABLED_KEY = "crc:quota-float-enabled:v1";
const FLOAT_ENABLED_EVENT = "crc:quota-float-enabled-changed";
const FLOAT_POS_KEY = "crc:quota-float-pos:v1";

function readFloatEnabled(): boolean {
  try {
    return localStorage.getItem(FLOAT_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeFloatEnabled(enabled: boolean) {
  try {
    localStorage.setItem(FLOAT_ENABLED_KEY, enabled ? "true" : "false");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(
    new CustomEvent(FLOAT_ENABLED_EVENT, { detail: enabled }),
  );
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
  const windows = orderedQuotaWindows(account.windows);
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
  const [floatEnabled, setFloatEnabled] = useState(readFloatEnabled);
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
    const unsubPins = subscribePinnedAccounts(setPinnedIds);
    const onFloatToggle = (event: Event) => {
      if (event instanceof CustomEvent) setFloatEnabled(Boolean(event.detail));
    };
    window.addEventListener(FLOAT_ENABLED_EVENT, onFloatToggle);
    return () => {
      unsubPins();
      window.removeEventListener(FLOAT_ENABLED_EVENT, onFloatToggle);
    };
  }, []);

  function togglePin(id: string) {
    const next = pinned.has(id)
      ? pinnedIds.filter((pinnedId) => pinnedId !== id)
      : [...pinnedIds, id];
    setPinnedIds(next);
    if (!writePinnedAccounts(next)) {
      onToast("Pin preference kept for this session; couldn't save it.");
    }
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
        <div className="kq-toolbar-actions">
          <button
            type="button"
            className={floatEnabled ? "is-on" : ""}
            aria-pressed={floatEnabled}
            title="Show a compact floating HUD for pinned accounts over Chat & 3D"
            onClick={() => {
              const next = !floatEnabled;
              setFloatEnabled(next);
              writeFloatEnabled(next);
            }}
          >
            {floatEnabled ? "Float HUD: ON" : "Float HUD"}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void reload(true)}
          >
            {loading ? "Checking…" : "Refresh"}
          </button>
        </div>
      </div>
      {pinnedAccounts.length === 0 && accounts.length > 0 && (
        <p className="kq-pin-hint">
          <PinIcon size={12} /> Pin any account below to float it on screen
          &amp; show it on the 3D Studio Quota Wall.
        </p>
      )}
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

/**
 * Compact, draggable, collapsible floating HUD that shows ONLY pinned quota
 * accounts. Docked at top-right of the workspace so it never obstructs the 3D
 * studio scene or the chat stream / composer.
 */
export function PinnedQuotaFloat({
  rightOffset = 50,
  onOpenUsage,
  onFocus3DQuota,
}: {
  rightOffset?: number;
  onOpenUsage?: () => void;
  onFocus3DQuota?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot | null>(() =>
    quotaSnapshot(),
  );
  const [pinned, setPinned] = useState<Set<string>>(
    () => new Set(readPinnedAccounts()),
  );
  const [enabled, setEnabled] = useState<boolean>(readFloatEnabled);
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [offset, setOffset] = useState<{ dx: number; dy: number }>(() => {
    try {
      const raw = localStorage.getItem(FLOAT_POS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { dx?: number; dy?: number };
        if (typeof parsed.dx === "number" && typeof parsed.dy === "number") {
          return { dx: parsed.dx, dy: parsed.dy };
        }
      }
    } catch {
      /* ignore */
    }
    return { dx: 0, dy: 0 };
  });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origDx: number;
    origDy: number;
  } | null>(null);

  useEffect(() => {
    const unsubQuota = subscribeQuota(setSnapshot);
    const unsubPins = subscribePinnedAccounts((ids) => setPinned(new Set(ids)));
    const onFloatToggle = () => setEnabled(readFloatEnabled());
    window.addEventListener(FLOAT_ENABLED_EVENT, onFloatToggle);
    if (!quotaSnapshot()) {
      void refreshQuota(false).catch(() => {});
    }
    return () => {
      unsubQuota();
      unsubPins();
      window.removeEventListener(FLOAT_ENABLED_EVENT, onFloatToggle);
    };
  }, []);

  const pinnedAccounts = (snapshot?.accounts ?? []).filter((account) =>
    pinned.has(account.id),
  );

  if (!enabled || pinnedAccounts.length === 0) return null;

  function unpin(id: string) {
    const next = [...pinned].filter((pinnedId) => pinnedId !== id);
    setPinned(new Set(next));
    writePinnedAccounts(next);
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshQuota(true);
    } catch {
      /* ignore */
    } finally {
      setRefreshing(false);
    }
  }

  function startDrag(event: ReactPointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origDx: offset.dx,
      origDy: offset.dy,
    };
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = Math.max(
      -window.innerWidth + 280,
      Math.min(120, drag.origDx + (event.clientX - drag.startX)),
    );
    const dy = Math.max(
      -36,
      Math.min(
        window.innerHeight - 140,
        drag.origDy + (event.clientY - drag.startY),
      ),
    );
    setOffset({ dx, dy });
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
      localStorage.setItem(FLOAT_POS_KEY, JSON.stringify(offset));
    } catch {
      /* ignore */
    }
  }

  function resetPosition() {
    const zero = { dx: 0, dy: 0 };
    setOffset(zero);
    try {
      localStorage.removeItem(FLOAT_POS_KEY);
    } catch {
      /* ignore */
    }
  }

  return (
    <aside
      className={`kq-float${collapsed ? " is-collapsed" : ""}`}
      aria-label="Pinned subscription quotas"
      style={{
        right: `${rightOffset}px`,
        transform: `translate3d(${offset.dx}px, ${offset.dy}px, 0)`,
      }}
    >
      <div
        className="kq-float-head"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetPosition}
        title="Drag to reposition · Double-click to reset position"
      >
        <span className="kq-float-pin-badge" aria-hidden="true">
          <PinIcon size={11} />
        </span>
        <strong className="kq-float-title">
          Pinned ({pinnedAccounts.length})
        </strong>
        {collapsed && (
          <div className="kq-float-pills">
            {pinnedAccounts.slice(0, 3).map((acc) => {
              const topWin = [...acc.windows].sort(
                (a, b) => b.used_percent - a.used_percent,
              )[0];
              const used = Math.max(
                0,
                Math.min(100, topWin?.used_percent ?? 0),
              );
              const rem = Math.round(100 - used);
              return (
                <span
                  key={acc.id}
                  className={`kq-float-pill${severity(used)}`}
                  title={`${providerName(acc.provider)} (${acc.name}): ${rem}% left`}
                >
                  {providerName(acc.provider).slice(0, 1)} {rem}%
                </span>
              );
            })}
          </div>
        )}
        <div className="kq-float-actions">
          {onFocus3DQuota && (
            <button
              type="button"
              onClick={onFocus3DQuota}
              title="Focus 3D camera on the Studio Quota Telemetry Wall"
            >
              3D
            </button>
          )}
          {!collapsed && (
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void handleRefresh()}
              title="Refresh pinned quota limits"
            >
              {refreshing ? "…" : "↻"}
            </button>
          )}
          {onOpenUsage && !collapsed && (
            <button
              type="button"
              onClick={onOpenUsage}
              title="Open full Usage & Quotas panel"
            >
              All
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            title={
              collapsed
                ? "Expand pinned usage card"
                : "Minimize to compact pill"
            }
          >
            {collapsed ? "+" : "—"}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="kq-float-list">
          {pinnedAccounts.map((account) => {
            const windows = orderedQuotaWindows(account.windows).slice(0, 2);
            return (
              <div className="kq-float-item" key={account.id}>
                <div className="kq-float-item-head">
                  <span className="kq-float-mark" aria-hidden="true">
                    {providerName(account.provider).slice(0, 1)}
                  </span>
                  <div className="kq-float-name">
                    <strong>{providerName(account.provider)}</strong>
                    <small>{account.name}</small>
                  </div>
                  <button
                    type="button"
                    className="kq-float-unpin"
                    onClick={() => unpin(account.id)}
                    title={`Unpin ${account.name} from floating HUD & 3D wall`}
                    aria-label={`Unpin ${account.name}`}
                  >
                    <PinIcon size={11} />
                  </button>
                </div>
                {windows.map((w) => {
                  const used = Math.max(0, Math.min(100, w.used_percent));
                  const remaining = Math.round(100 - used);
                  const reset = formatReset(w.resets_at);
                  return (
                    <div
                      className={`kq-float-win${severity(used)}`}
                      key={w.label}
                    >
                      <div className="kq-float-win-row">
                        <span className="kq-float-win-label" title={w.label}>
                          <i aria-hidden="true" />
                          {w.label}
                        </span>
                        <span className="kq-float-win-pct">
                          {remaining}%
                          {reset ? (
                            <small> · {reset.replace(/^resets /, "")}</small>
                          ) : null}
                        </span>
                      </div>
                      <div className={`kq-bar${severity(used)}`}>
                        <span style={{ width: `${remaining}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
