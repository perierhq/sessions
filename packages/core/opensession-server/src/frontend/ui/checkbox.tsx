import * as React from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { cn } from "./cn";

type CheckboxProps = Omit<
  React.ComponentProps<typeof BaseCheckbox.Root>,
  "size"
> & {
  className?: string;
};

/**
 * The app's checkbox: a form option you pick, as opposed to `Switch`, which
 * turns a setting on. It replaces the browser's own `input[type=checkbox]`,
 * whose fill is the UA accent rather than ours and whose box ignores the
 * corner and border scales every other control follows.
 *
 * It is labelable, so the existing pattern still works and the whole row stays
 * clickable:
 *
 *   <label className="flex items-center gap-2">
 *     <Checkbox checked={x} onCheckedChange={setX} />
 *     Include thread replies
 *   </label>
 *
 * `indeterminate` (a select-all over a partial selection) draws a dash on the
 * same fill. Base UI drops `data-checked` while it is set, so the fill and the
 * glyph key off `data-indeterminate` on the root.
 */
export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <BaseCheckbox.Root
      className={cn(
        "group flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-line-strong bg-surface p-0 outline-none",
        "transition-[background-color,border-color] duration-[var(--dur-micro)] ease-[var(--ease)]",
        "hover:border-faint",
        "data-[checked]:border-accent-control data-[checked]:bg-accent-control data-[checked]:hover:border-accent-control",
        "data-[indeterminate]:border-accent-control data-[indeterminate]:bg-accent-control data-[indeterminate]:hover:border-accent-control",
        "focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "data-[disabled]:cursor-default data-[disabled]:opacity-40",
        className,
      )}
      {...props}
    >
      <BaseCheckbox.Indicator className="flex text-on-accent-control data-[unchecked]:hidden">
        <svg
          viewBox="0 0 12 12"
          className="size-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path
            d="M2.4 6.3 4.7 8.6 9.6 3.5"
            className="group-data-[indeterminate]:hidden"
          />
          <path
            d="M3 6h6"
            className="hidden group-data-[indeterminate]:block"
          />
        </svg>
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
