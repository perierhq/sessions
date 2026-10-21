import type * as React from "react";
import { useState } from "react";
import {
  DIALOG_INPUT,
  FIELD_ERROR,
  FIELD_HINT,
  FORM_SECTION_TITLE,
} from "../../../lib/incident-settings-classes";
import { listToText, textToList } from "../../../lib/incidents/access-form";
import { type HeaderDraft, REDACTED } from "../../../lib/incidents/signal-form";
import { Button } from "../../../ui/button";
import { cn } from "../../../ui/cn";
import { CopyCheck, useCopy } from "../../../ui/copy";
import { Input } from "../../../ui/input";
import { IconCopy, IconPlus, IconX } from "../../icons";

/**
 * A labelled control with its message under it. `htmlFor` ties the label to
 * a text input; a select or a segmented control names itself, so the label
 * is only drawn. The message is the field's error when there is one, else
 * its hint, and `messageId` lets the control point at it.
 */
export function FormField({
  label,
  htmlFor,
  error,
  hint,
  messageId,
  className,
  children,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  error?: string | null;
  hint?: React.ReactNode;
  messageId?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-label font-medium text-dim">
          {label}
        </label>
      ) : (
        <span className="text-label font-medium text-dim">{label}</span>
      )}
      {children}
      {error ? (
        <p id={messageId} className={FIELD_ERROR}>
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className={FIELD_HINT}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A group of fields under a small heading, inside a dialog. */
export function FormSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className={FORM_SECTION_TITLE}>{title}</h3>
      {children}
    </section>
  );
}

/**
 * A number, typed. The text is the field's own while it is edited,
 * so clearing it to type another number never snaps back; `onChange` hears
 * only numbers.
 */
export function NumberField({
  id,
  value,
  onChange,
  min,
  max,
  step = 1,
  decimal = false,
  describedBy,
}: {
  id: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  decimal?: boolean;
  describedBy?: string;
}) {
  // Seeded once: callers key the field by what it edits, so a new rule
  // starts a new field.
  const [text, setText] = useState(String(value));
  return (
    <Input
      id={id}
      type="number"
      inputMode={decimal ? "decimal" : "numeric"}
      min={min}
      max={max}
      step={step}
      value={text}
      aria-describedby={describedBy}
      className={cn("tabular-nums", DIALOG_INPUT)}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        const n = Number(next);
        if (next.trim() !== "" && Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

/** A URL to hand to another system, selectable, with a Copy button. */
export function CopyUrl({ url, label }: { url: string; label: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-control bg-surface py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 select-all font-mono text-meta text-fg [overflow-wrap:anywhere]">
        {url}
      </code>
      <Button
        type="button"
        variant="soft"
        size="sm"
        aria-label={`Copy ${label}`}
        icon={
          <CopyCheck copied={copied} size={15} idle={<IconCopy size={15} />} />
        }
        className="shrink-0 phone:min-h-11"
        onClick={() => copy(url, { toast: "Copied" })}
      >
        Copy
      </Button>
    </div>
  );
}

/**
 * Header rows: a name, a value, and a remove button each. A stored value
 * comes back hidden; its field stays empty with "Saved and hidden" until a
 * new value is typed.
 */
export function HeaderRows({
  idPrefix,
  rows,
  onChange,
  error,
}: {
  idPrefix: string;
  rows: HeaderDraft[];
  onChange: (rows: HeaderDraft[]) => void;
  error?: string | null;
}) {
  const errorId = `${idPrefix}-error`;
  const set = (i: number, patch: Partial<HeaderDraft>) =>
    onChange(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        // Rows have no identity of their own; position is the identity.
        <div key={i} className="flex min-w-0 items-center gap-2">
          <Input
            id={i === 0 ? idPrefix : undefined}
            aria-label="Header name"
            placeholder="Name"
            value={row.name}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={error ? errorId : undefined}
            className={cn("min-w-0 flex-1 font-mono", DIALOG_INPUT)}
            onChange={(event) => set(i, { name: event.currentTarget.value })}
          />
          <Input
            aria-label={`Value of ${row.name || "the header"}`}
            type={row.hidden ? "password" : "text"}
            placeholder={row.hidden ? "Saved and hidden" : "Value"}
            value={row.hidden && row.value === REDACTED ? "" : row.value}
            autoComplete="off"
            spellCheck={false}
            className={cn("min-w-0 flex-[1.4] font-mono", DIALOG_INPUT)}
            onChange={(event) => {
              const value = event.currentTarget.value;
              // Emptied again: keep the stored value.
              set(i, { value: row.hidden && !value ? REDACTED : value });
            }}
          />
          <Button
            type="button"
            variant="ghost"
            aria-label={`Remove ${row.name || "header"}`}
            icon={<IconX size={18} />}
            className="size-11 shrink-0 justify-center p-0 desktop:size-8"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      {error && (
        <p id={errorId} className={FIELD_ERROR}>
          {error}
        </p>
      )}
      <div>
        <Button
          type="button"
          variant="soft"
          size="sm"
          icon={<IconPlus size={16} />}
          className="phone:min-h-11"
          onClick={() => onChange([...rows, { name: "", value: "" }])}
        >
          Add a header
        </Button>
      </div>
    </div>
  );
}

/**
 * A comma list, typed. The text is the field's own while it is edited, so
 * a trailing comma never vanishes under the cursor; `onChange` hears the
 * trimmed items.
 */
export function ListInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  label,
  mono = true,
}: {
  id?: string;
  value: string[];
  onChange: (list: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  /** The accessible name when no `<label>` points at the field. */
  label?: string;
  mono?: boolean;
}) {
  // Seeded once: callers key the field by what it edits.
  const [text, setText] = useState(() => listToText(value));
  return (
    <Input
      id={id}
      aria-label={label}
      value={disabled ? listToText(value) : text}
      placeholder={placeholder}
      disabled={disabled}
      autoComplete="off"
      spellCheck={false}
      className={cn(mono && "font-mono", DIALOG_INPUT)}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        onChange(textToList(next));
      }}
    />
  );
}
