import { useIsPhone } from "../../hooks/useIsPhone";
import { Button } from "../../ui/button";
import { ResponsiveDialog } from "../../ui/sheet";
import { IconX } from "../icons";

/** A sheet the summary rows open: a centred dialog on a desktop, a bottom
 *  sheet on a phone, with a visible Close. The Findings section opens the
 *  agents' cost in one too. */
export function DetailSheet({
  title,
  open,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  /** Room for a page's worth of content (findings, a tool's output). */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const phone = useIsPhone();
  return (
    <ResponsiveDialog
      open={open}
      onClose={onClose}
      phone={phone}
      label={title}
      sheetClassName="max-h-[88dvh]"
      modalClassName={
        wide
          ? "w-[min(880px,calc(100vw-32px))] max-h-[min(800px,calc(100dvh-32px))]"
          : "w-[min(560px,calc(100vw-32px))] max-h-[min(640px,calc(100dvh-32px))]"
      }
    >
      {(dismiss) => (
        <div className="flex min-h-0 flex-col">
          <header className="flex shrink-0 items-center gap-3 px-5 pt-4 pb-2 phone:px-4">
            <h2 className="m-0 min-w-0 flex-1 truncate text-dialog-title font-semibold text-fg">
              {title}
            </h2>
            <Button
              variant="ghost"
              size="lg"
              className="phone:min-h-11 phone:min-w-11"
              aria-label="Close"
              icon={<IconX />}
              onClick={dismiss}
            />
          </header>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pb-5 phone:px-4">
            {children}
          </div>
        </div>
      )}
    </ResponsiveDialog>
  );
}
