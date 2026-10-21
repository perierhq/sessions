import * as React from "react";
import { cn } from "./cn";

/**
 * A button that brings no plate of its own: a whole row that opens what it
 * names (a list or table row, a summary row, a sidebar row), a band's
 * heading toggle, or a link-weight action. It carries what every one of them
 * needs and kept rewriting: `type="button"`, the keyboard focus ring, the
 * pointer, and a disabled state. The caller lays it out and paints its
 * hover; for a control with a plate, use `Button`.
 */
export const PlainButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<"button">
>(function PlainButton({ className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "cursor-pointer border-0 bg-transparent p-0 text-left focus-ring disabled:cursor-default disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
});
