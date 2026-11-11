// Blob's card in Settings, Members: everything under the identity row sits
// in the title column (past the 28px avatar), so its subheads and rows share
// one inset.

/** The title column's inset inside the card. */
export const blobInset = "pl-16 pr-5";

/** A part's heading inside the card ("Project leads", "GitHub account"). */
export const blobSubhead = `pb-1 pt-2 ${blobInset} text-label font-semibold text-faint`;
