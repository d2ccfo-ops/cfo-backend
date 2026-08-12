import { describe, expect, it } from "vitest";
import { extractAccountIdentifier, parseCsvLine, parseStatementCsv } from "./index.js";

// The full email-resolution flow (multiple BANK connections, matching an
// identifier to the right one, refusing on ambiguity) needs a database — that
// stays in scripts/checkEmailIngest.ts. extractAccountIdentifier() itself
// takes no DB input, so its "does this file name one consistent account"
// judgment is fully unit-testable.
describe("extractAccountIdentifier", () => {
  it("returns null when there is no account column at all", () => {
    const csv = ["date,description,amount,type", "2026-08-01,Sale,500,CREDIT"].join("\n");
    expect(extractAccountIdentifier(csv)).toEqual({ identifier: null, ambiguous: false });
  });

  it("reads the account when every row agrees", () => {
    const csv = [
      "date,description,amount,type,account",
      "2026-08-01,Sale,500,CREDIT,1234567890",
      "2026-08-02,Fee,10,DEBIT,1234567890",
    ].join("\n");
    expect(extractAccountIdentifier(csv)).toEqual({ identifier: "1234567890", ambiguous: false });
  });

  it("is ambiguous when rows disagree on the account", () => {
    const csv = [
      "date,description,amount,type,account",
      "2026-08-01,Sale,500,CREDIT,1111",
      "2026-08-02,Sale,600,CREDIT,2222",
    ].join("\n");
    expect(extractAccountIdentifier(csv)).toEqual({ identifier: null, ambiguous: true });
  });

  it("matches a variety of accepted column spellings", () => {
    for (const col of ["Account", "Account Number", "AccountNo", "Last4", "Account Last4"]) {
      const csv = [`date,description,amount,type,${col}`, "2026-08-01,Sale,500,CREDIT,0000"].join("\n");
      expect(extractAccountIdentifier(csv).identifier).toBe("0000");
    }
  });

  it("ignores blank account cells rather than treating them as a value", () => {
    const csv = [
      "date,description,amount,type,account",
      "2026-08-01,Sale,500,CREDIT,",
      "2026-08-02,Sale,600,CREDIT,9999",
    ].join("\n");
    expect(extractAccountIdentifier(csv)).toEqual({ identifier: "9999", ambiguous: false });
  });

  it("returns null on an empty file rather than throwing", () => {
    expect(extractAccountIdentifier("")).toEqual({ identifier: null, ambiguous: false });
  });
});

describe("parseCsvLine", () => {
  it("handles a quoted field containing a comma", () => {
    expect(parseCsvLine('2026-08-01,"NEFT, salary credit",500,CREDIT')).toEqual([
      "2026-08-01",
      "NEFT, salary credit",
      "500",
      "CREDIT",
    ]);
  });

  it("unescapes a doubled quote inside a quoted field", () => {
    expect(parseCsvLine('x,"say ""hi""",y')).toEqual(["x", 'say "hi"', "y"]);
  });
});

describe("parseStatementCsv — extra columns don't break required-column parsing", () => {
  it("still parses correctly when an account column is present", () => {
    const csv = [
      "date,description,amount,type,account",
      "2026-08-01,Sale,500.50,CREDIT,1234",
    ].join("\n");
    const { rows, errors } = parseStatementCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ date: "2026-08-01", description: "Sale", amount: 500.5, direction: "CREDIT" }]);
  });
});
