import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Field, Group, ItemRow, Subhead, SwitchField } from "./settings-ui";

type RouterView = {
  id: string;
  name: string;
  url: string;
  password_set: boolean;
};

type QuotaSettings = { claude: boolean; routers: RouterView[] };

type Draft = { id: string | null; name: string; url: string; password: string };
const EMPTY: Draft = { id: null, name: "", url: "", password: "" };

/** Where the Usage panel reads quota from: the Claude login and 9routers. */
export default function UsageSettings({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const [settings, setSettings] = useState<QuotaSettings | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<QuotaSettings>("get_quota_settings")
      .then((value) => {
        if (Array.isArray(value?.routers)) setSettings(value);
      })
      .catch((e) => setError(String(e)));
  }, []);

  async function run(work: () => Promise<QuotaSettings>, done?: string) {
    setBusy(true);
    try {
      setSettings(await work());
      setError("");
      if (done) onToast(done);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    const saved = await run(
      () =>
        invoke<QuotaSettings>("save_router", {
          id: draft.id,
          name: draft.name,
          url: draft.url,
          // Empty keeps the stored password when editing.
          password: draft.password || null,
        }),
      `${draft.name.trim() || "9router"} connected`,
    );
    if (saved) setDraft(EMPTY);
  }

  if (!settings) return null;
  return (
    <>
      <Subhead>Usage</Subhead>
      <Group label="Subscription usage">
        <SwitchField
          label="Claude subscription"
          detail="Reads your Claude login from the Keychain, read-only (macOS asks once)."
          checked={settings.claude}
          disabled={busy}
          onChange={(enabled) =>
            void run(() =>
              invoke<QuotaSettings>("set_quota_claude", { enabled }),
            )
          }
        />
        {settings.routers.map((router) => (
          <ItemRow
            key={router.id}
            title={router.name}
            detail={`${router.url}${router.password_set ? "" : " · password missing"}`}
          >
            <button
              type="button"
              className="kset-link-button"
              disabled={busy}
              onClick={() =>
                setDraft({
                  id: router.id,
                  name: router.name,
                  url: router.url,
                  password: "",
                })
              }
            >
              Edit
            </button>
            <button
              type="button"
              className="kset-link-button"
              disabled={busy}
              aria-label={`Remove ${router.name}`}
              onClick={() =>
                void run(
                  () =>
                    invoke<QuotaSettings>("delete_router", { id: router.id }),
                  `${router.name} removed`,
                )
              }
            >
              Remove
            </button>
          </ItemRow>
        ))}
      </Group>

      <Group label={draft.id ? "Edit 9router" : "Add 9router"}>
        <Field label="Name" detail="Shown as the heading in the Usage panel.">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Local"
          />
        </Field>
        <Field label="URL">
          <input
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder="http://localhost:20128"
          />
        </Field>
        <Field
          label="Dashboard password"
          detail={
            draft.id
              ? "Leave empty to keep the saved one."
              : "Stored in the Keychain. A fresh 9router uses 123456."
          }
        >
          <input
            type="password"
            value={draft.password}
            onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            autoComplete="off"
          />
        </Field>
      </Group>
      {error && (
        <div className="kset-inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="kset-actions-row">
        <button
          type="button"
          disabled={busy || !draft.url.trim()}
          onClick={() => void saveDraft()}
        >
          {busy ? "Checking…" : draft.id ? "Save 9router" : "Add 9router"}
        </button>
        {draft.id && (
          <button type="button" disabled={busy} onClick={() => setDraft(EMPTY)}>
            Cancel
          </button>
        )}
        <span>Usage shows in the chat's right sidebar.</span>
      </div>
    </>
  );
}
