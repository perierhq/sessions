import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatTimeOfDay, isTimeOfDay } from "../lib/time-of-day";
import { TimeOfDayField, TimeZoneField } from "./time-of-day";

test("validates and formats wall times", () => {
  expect(isTimeOfDay("23:00")).toBe(true);
  expect(isTimeOfDay("00:00")).toBe(true);
  expect(isTimeOfDay("24:00")).toBe(false);
  expect(isTimeOfDay("7:00")).toBe(false);
  expect(isTimeOfDay("12:60")).toBe(false);
  expect(formatTimeOfDay("07:05")).toBe(
    new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    }).format(Date.UTC(2000, 0, 1, 7, 5)),
  );
  expect(formatTimeOfDay("nope")).toBe("nope");
});

test("renders a native time input with an accessible name", () => {
  const html = renderToStaticMarkup(
    <TimeOfDayField value="23:00" onChange={() => {}} label="From" />,
  );
  expect(html).toContain('type="time"');
  expect(html).toContain('value="23:00"');
  expect(html).toContain('aria-label="From"');
  expect(html).toContain('step="60"');
  expect(html).toContain("phone:text-input-phone");
});

test("the time zone field names its zone", () => {
  const html = renderToStaticMarkup(
    <TimeZoneField value="Europe/Warsaw" onChange={() => {}} />,
  );
  expect(html).toContain('aria-label="Time zone"');
  expect(html).toContain("Europe/Warsaw");
});
