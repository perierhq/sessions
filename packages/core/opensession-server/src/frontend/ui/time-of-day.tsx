import { isTimeOfDay, timeZoneOptions } from "../lib/time-of-day";
import { cn } from "./cn";
import { SearchSelect } from "./combobox";
import { fieldClasses } from "./input";

/**
 * A wall time of day, `HH:MM`. The platform's own control: a wheel on a
 * phone, the locale's 12 or 24 hour clock everywhere. `onChange` only ever
 * receives a complete, valid time.
 */
export function TimeOfDayField({
  value,
  onChange,
  label,
  disabled,
  className,
  ...aria
}: {
  value: string;
  onChange: (hhmm: string) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  return (
    <input
      type="time"
      step={60}
      value={value}
      disabled={disabled}
      aria-label={label}
      className={fieldClasses(
        "md",
        cn("tabular-nums phone:min-h-11 phone:text-input-phone", className),
      )}
      onChange={(event) => {
        const next = event.currentTarget.value.slice(0, 5);
        if (isTimeOfDay(next)) onChange(next);
      }}
      {...aria}
    />
  );
}

/** An IANA time zone, searchable. */
export function TimeZoneField({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <SearchSelect
      value={value}
      options={timeZoneOptions(value).map((zone) => ({
        value: zone,
        label: zone.replaceAll("_", " "),
      }))}
      onChange={onChange}
      label="Time zone"
      searchPlaceholder="Search time zones"
      emptyText="No time zone matches"
      disabled={disabled}
      className={cn("phone:min-h-11", className)}
      align="start"
    />
  );
}
