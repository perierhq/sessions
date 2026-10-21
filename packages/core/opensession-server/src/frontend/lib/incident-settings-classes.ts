// Class strings for the per-project incident settings and their dialogs.

/** The page frame: a Settings tool view brings its own scroll and padding
 *  (the settings column only pads its own panels). On a phone the sheet
 *  already pads its column, so the cards line up with every other panel. */
export const INCIDENT_SETTINGS_FRAME =
  "flex min-h-0 flex-1 justify-center overflow-y-auto px-8 pt-11 pb-22 phone:px-0 phone:pt-0 phone:pb-12";

/** A row control too wide for half a phone row (the four autonomy levels):
 *  it takes the full width under the text instead of truncating. */
export const SETTING_WIDE_CONTROL =
  "phone:ml-0 phone:max-w-none phone:basis-full";
export const SETTING_WIDE_SELECT = "phone:w-full phone:justify-between";

/** A settings row that opens something: the whole row is the button, 44px
 *  at least, washing on hover inside the card's corner. Mirrors
 *  `SettingRow`'s padding so it lines up with the switch rows around it. */
export const SETTING_LINK_ROW =
  "focus-ring flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 text-left hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent";

/** The text column of a link row (`SettingRowText`, as spans: a button may
 *  only hold phrasing content). */
export const SETTING_LINK_TEXT = "block min-w-0 flex-1 phone:min-w-[45%]";
export const SETTING_LINK_TITLE = "block text-item-title font-medium text-fg";
export const SETTING_LINK_DESC =
  "mt-1 block text-supporting text-dim phone:text-meta [overflow-wrap:anywhere]";

/** The value on the right of a link row, beside its chevron. */
export const SETTING_LINK_VALUE =
  "ml-auto flex min-w-0 max-w-[60%] flex-wrap items-center justify-end gap-1.5 text-supporting text-dim tabular-nums phone:max-w-[50%]";

/** A value of chips (badges) that drops under the text on a phone. */
export const SETTING_LINK_VALUE_STACKED =
  "phone:order-last phone:max-w-none phone:basis-full phone:justify-start";

export const SETTING_LINK_CHEVRON = "shrink-0 text-faint";

/** A settings dialog's frame: header, scrolling body, footer. */
export const SETTINGS_DIALOG_MODAL =
  "w-[min(520px,calc(100vw-32px))] max-h-[min(720px,calc(100dvh-32px))]";
export const SETTINGS_DIALOG_MODAL_WIDE =
  "w-[min(640px,calc(100vw-32px))] max-h-[min(820px,calc(100dvh-32px))]";
export const SETTINGS_DIALOG_SHEET = "max-h-[92dvh]";
export const SETTINGS_DIALOG_HEADER =
  "flex shrink-0 items-center gap-3 px-5 pt-4 pb-2 phone:px-4";
export const SETTINGS_DIALOG_TITLE =
  "m-0 min-w-0 flex-1 truncate text-dialog-title font-semibold text-fg";
export const SETTINGS_DIALOG_BODY =
  "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pt-2 pb-4 phone:px-4";
export const SETTINGS_DIALOG_FOOTER =
  "flex shrink-0 flex-col gap-3 border-t border-line px-5 py-3 phone:px-4";
export const SETTINGS_DIALOG_BUTTONS =
  "flex flex-wrap items-center justify-end gap-2 phone:[&>button]:min-h-11";

/** A checkbox (or switch) with its words: the whole line is the target,
 *  44px under a finger. */
export const CHECK_ROW =
  "flex min-h-9 cursor-pointer items-center gap-3 text-body text-fg phone:min-h-11";

/** A field's own message, under it. */
export const FIELD_ERROR = "m-0 text-meta text-red";
/** A field's hint, under it. */
export const FIELD_HINT = "m-0 text-meta text-dim";

/** Text inputs inside these dialogs: 44px and 16px on a phone. */
export const DIALOG_INPUT = "phone:min-h-11 phone:text-input-phone";

/** A heading over a group of fields inside a dialog. */
export const FORM_SECTION_TITLE = "m-0 text-label font-semibold text-fg";

/** The mapping preview: a well under the fields, filled, never outlined. */
export const MAPPING_PREVIEW =
  "flex flex-col gap-3 rounded-xl bg-surface p-4 phone:p-3";

/** "What each path found": each path over what it matched, so a long
 *  filter path never squeezes the values into a column of fragments. */
export const MAPPING_FOUND_LIST = "m-0 flex flex-col gap-2 p-0";
export const MAPPING_FOUND_ROW = "flex min-w-0 flex-col";

/** A raw response body: content, so it is selectable. */
export const MAPPING_RAW =
  "m-0 max-h-64 select-text overflow-auto whitespace-pre-wrap font-mono text-meta text-dim [overflow-wrap:anywhere]";

/** A maintenance window in a list: what it says, then Edit and Remove.
 *  The buttons drop under the text on a phone. */
export const WINDOW_ROW =
  "flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl bg-surface py-2 pr-2 pl-3";
export const WINDOW_ROW_TEXT = "min-w-0 flex-1 basis-56";

/** An action row's caption: the host, then the command's first line in
 *  monospace, cut to one line. */
export const ACTION_ROW_DESC = "flex min-w-0 items-baseline gap-1.5";
export const ACTION_ROW_COMMAND = "min-w-0 truncate font-mono text-meta";

/** The production hosts list inside its dialog: rows divided by a line. */
export const HOST_LIST = "flex flex-col divide-y divide-line";
export const HOST_ROW = "flex min-h-11 items-center gap-3 py-3";
export const HOST_ROW_TEXT = "flex min-w-0 flex-1 flex-col gap-0.5";
export const HOST_ROW_NAME = "truncate text-body font-medium text-fg";

/** A one-time pairing command: a well under the list, filled, never
 *  outlined (the mapping preview's recipe). */
export const PAIRING_WELL =
  "flex flex-col gap-2 rounded-xl bg-surface p-4 phone:p-3";
