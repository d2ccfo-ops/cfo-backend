import { describe, expect, it } from "vitest";
import { toCsv } from "./evidence.js";

// buildEvidence() itself needs the live DB (its five branches each call a
// calc module against Prisma) — that stayed a live probe during development.
// toCsv() is the pure half: given rows, produce well-formed CSV. Its
// escaping rules are exactly what a founder's spreadsheet import breaks on
// silently, which is why they're pinned here rather than trusted by eye.
describe("toCsv", () => {
  it("returns an empty string for no rows, not a header-only CSV", () => {
    expect(toCsv([])).toBe("");
  });

  it("derives headers from the first row's keys, in that order", () => {
    const csv = toCsv([{ orderNumber: "#1001", amountRupees: 500 }]);
    expect(csv.split("\n")[0]).toBe("orderNumber,amountRupees");
    expect(csv.split("\n")[1]).toBe("#1001,500");
  });

  it("quotes and escapes values containing commas, quotes or newlines", () => {
    const csv = toCsv([{ description: 'Contains, a comma and a "quote"' }]);
    expect(csv.split("\n")[1]).toBe('"Contains, a comma and a ""quote"""');
  });

  it("quotes a value containing a newline", () => {
    const csv = toCsv([{ note: "line one\nline two" }]);
    expect(csv.split("\n").slice(1).join("\n")).toBe('"line one\nline two"');
  });

  it("renders null and undefined as an empty field, not the string \"null\"", () => {
    const csv = toCsv([{ cogsRupees: null }]);
    expect(csv.split("\n")[1]).toBe("");
  });

  it("does not quote a plain numeric or short alphanumeric value", () => {
    const csv = toCsv([{ sku: "BR-CITRIN", units: 2 }]);
    expect(csv.split("\n")[1]).toBe("BR-CITRIN,2");
  });
});
