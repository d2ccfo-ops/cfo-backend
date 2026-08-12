import { describe, expect, it } from "vitest";
import { cellToCsvSafe, rowsToCsv } from "./xlsxToCsv.js";

describe("cellToCsvSafe", () => {
  it("renders a Date as YYYY-MM-DD, in UTC", () => {
    expect(cellToCsvSafe(new Date("2026-03-05T00:00:00.000Z"))).toBe("2026-03-05");
  });

  it("pads single-digit month and day", () => {
    expect(cellToCsvSafe(new Date("2026-01-02T00:00:00.000Z"))).toBe("2026-01-02");
  });

  it("passes through strings, numbers, booleans and null unchanged", () => {
    expect(cellToCsvSafe("NEFT credit")).toBe("NEFT credit");
    expect(cellToCsvSafe(1500.5)).toBe(1500.5);
    expect(cellToCsvSafe(true)).toBe(true);
    expect(cellToCsvSafe(null)).toBe(null);
  });
});

describe("rowsToCsv", () => {
  it("joins cells with commas and rows with newlines", () => {
    const rows = [
      ["date", "description", "amount", "type"],
      ["2026-03-05", "NEFT credit", 1000, "CREDIT"],
    ];
    expect(rowsToCsv(rows)).toBe("date,description,amount,type\n2026-03-05,NEFT credit,1000,CREDIT");
  });

  it("quotes a field containing a comma and doubles embedded quotes", () => {
    const rows = [["date", "description"], ["2026-03-05", 'NEFT, ref "12345"']];
    expect(rowsToCsv(rows)).toBe('date,description\n2026-03-05,"NEFT, ref ""12345"""');
  });

  it("renders null/undefined cells as an empty field, not the string \"null\"", () => {
    expect(rowsToCsv([["a", null, "c"]])).toBe("a,,c");
  });

  it("converts a Date cell through cellToCsvSafe before quoting", () => {
    const rows = [["date"], [new Date("2026-12-31T00:00:00.000Z")]];
    expect(rowsToCsv(rows)).toBe("date\n2026-12-31");
  });
});
