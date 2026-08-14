import { useCallback, useEffect, useState } from "react";
import { useModalFocus } from "./useModalFocus";

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type Pending = ConfirmOptions & { resolve: (value: boolean) => void };

// Module-level opener wired by <ConfirmHost />. Falls back to native confirm if host unmounted.
let opener: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return opener ? opener(opts) : Promise.resolve(window.confirm(opts.message));
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);

  const open = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setPending({ ...opts, resolve });
  }), []);

  useEffect(() => {
    opener = open;
    return () => { if (opener === open) opener = null; };
  }, [open]);

  const close = useCallback((value: boolean) => {
    const resolve = pending?.resolve;
    setPending(null);
    // Let React remove the modal before the confirmed action starts heavy work.
    window.setTimeout(() => resolve?.(value), 0);
  }, [pending]);

  const dialogRef = useModalFocus<HTMLDivElement>(() => close(false), Boolean(pending));
  if (!pending) return null;

  return (
    <div className="approval-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(false); }}>
      <section ref={dialogRef} className="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" tabIndex={-1}>
        <header>
          <small>{pending.danger ? "CONFIRM · CAUTION" : "CONFIRM"}</small>
          <h2 id="confirm-title">{pending.title ?? "Confirm action"}</h2>
        </header>
        <p className="approval-message">{pending.message}</p>
        <div className="approval-options approval-confirm">
          <button onClick={() => close(false)}><span>×</span>{pending.cancelLabel ?? "Cancel"}</button>
          <button className={`approval-primary${pending.danger ? " approval-danger" : ""}`} onClick={() => close(true)}><span>✓</span>{pending.confirmLabel ?? "Confirm"}</button>
        </div>
      </section>
    </div>
  );
}
