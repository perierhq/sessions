import React, { useEffect, useRef } from "react";
import { noAutofill } from "../lib/composer-autofill";
import {
  composerBox,
  composerBoxExpanded,
  composerSend,
  composerSendDefault,
  composerTextarea,
  composerTextareaPadding,
  composerToolbar,
} from "../lib/composer-classes";
import { cn } from "../ui/cn";
import { PlainButton } from "../ui/plain-button";
import { IconArrowUp } from "./icons";

/**
 * The support conversation's reply box, shared by Plain and email: the
 * session composer's plate, a textarea that grows with its text, an error
 * line, and a toolbar. ⌘/Ctrl+Enter submits. What a channel adds goes in its
 * slots: `header` above the text (staged attachments, an agent draft's state
 * and sources) and the toolbar's children (attach and the internal-note
 * toggle for Plain, a draft's Send, Discard and Stop for email). The text
 * itself is the caller's, usually from `useSavedDraft`.
 */
export function SupportComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  label,
  disabled,
  readOnly,
  error,
  header,
  children,
  toolbarClassName,
  textareaClassName,
  className,
  style,
}: {
  value: string;
  onChange: (next: string) => void;
  /** ⌘/Ctrl+Enter. Leave it out while the text cannot be sent. */
  onSubmit?: () => void;
  placeholder: string;
  /** The textarea's accessible name. */
  label: string;
  disabled?: boolean;
  readOnly?: boolean;
  error?: string | null;
  header?: React.ReactNode;
  /** The toolbar under the text. */
  children?: React.ReactNode;
  toolbarClassName?: string;
  textareaClassName?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "";
    if (value) el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <div
      className={cn(
        "composer shrink-0",
        composerBox,
        composerBoxExpanded,
        className,
      )}
      style={style}
    >
      {header}
      <textarea
        ref={textareaRef}
        rows={1}
        {...noAutofill}
        className={cn(
          "composer-textarea min-h-12 text-fg placeholder:text-faint",
          composerTextarea,
          composerTextareaPadding,
          textareaClassName,
        )}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && onSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {error && (
        <div
          className="mt-1 text-label text-red [overflow-wrap:anywhere]"
          role="alert"
        >
          {error}
        </div>
      )}
      <div className={cn(composerToolbar, toolbarClassName)}>{children}</div>
    </div>
  );
}

/** The composer's round send button, at the toolbar's trailing edge. */
export function SupportSendButton({
  label,
  onClick,
  disabled,
}: {
  /** Its accessible name: what pressing it sends. */
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <PlainButton
      className={cn("ml-auto", composerSend, composerSendDefault)}
      onClick={onClick}
      disabled={disabled}
      title="Send (⌘↵)"
      aria-label={label}
    >
      <IconArrowUp size={24} />
    </PlainButton>
  );
}
