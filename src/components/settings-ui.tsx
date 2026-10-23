import type { ReactNode } from "react";

/*
 * Shared building blocks for every Settings section, so each panel renders
 * the same row layout (styles live in settings.css under kset-*).
 */

/** Bordered block of rows. */
export function Group({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <div
      className="kset-group"
      role={label ? "group" : undefined}
      aria-label={label}
    >
      {children}
    </div>
  );
}

/**
 * One setting: title and description on the left, control on the right.
 * Rendered as a <label> so the title names the control for assistive tech.
 * `wide` stacks the control under the text for multi-line inputs.
 */
export function Field({
  label,
  detail,
  wide = false,
  children,
}: {
  label: string;
  detail?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`kset-row${wide ? " kset-row--wide" : ""}`}>
      <span className="kset-row-text">
        <span className="kset-row-title">{label}</span>
        {detail && <span className="kset-row-desc">{detail}</span>}
      </span>
      <span className="kset-row-control">{children}</span>
    </label>
  );
}

/** A row whose only content is text plus trailing actions (lists). */
export function ItemRow({
  title,
  detail,
  children,
}: {
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="kset-row">
      <span className="kset-row-text">
        <span className="kset-row-title">{title}</span>
        {detail && <span className="kset-row-desc">{detail}</span>}
      </span>
      {children && <span className="kset-row-control">{children}</span>}
    </div>
  );
}

/** On/off setting. Native checkbox semantics, switch styling. */
export function SwitchField({
  label,
  detail,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  detail?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Field label={label} detail={detail}>
      <span className="kset-switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span aria-hidden="true" />
      </span>
    </Field>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="kset-note">{children}</p>;
}

export function Subhead({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="kset-subhead-row">
      <h3 className="kset-subhead">{children}</h3>
      {actions && <div className="kset-subhead-actions">{actions}</div>}
    </div>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="kset-actions-row">{children}</div>;
}

export function Status({
  error,
  success,
}: {
  error?: string;
  success?: string;
}) {
  return (
    <>
      {error && (
        <div className="kset-inline-error" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="kset-inline-success" role="status">
          {success}
        </div>
      )}
    </>
  );
}
