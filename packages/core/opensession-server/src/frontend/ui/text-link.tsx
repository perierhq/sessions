import * as React from "react";
import { cn } from "./cn";
import { PlainButton } from "./plain-button";

/**
 * A link-weight action inside a line of text, such as a hint naming the
 * settings page it points at: underlined in the text's own colour, darker
 * on hover, with a hit area taller than the line so a finger can take it.
 */
export const TextLink = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<"button">
>(function TextLink({ className, ...props }, ref) {
  return (
    <PlainButton
      ref={ref}
      className={cn(
        "relative text-dim underline decoration-line-strong underline-offset-2 before:absolute before:-inset-x-1 before:-inset-y-3 before:content-[''] hover:text-fg",
        className,
      )}
      {...props}
    />
  );
});
