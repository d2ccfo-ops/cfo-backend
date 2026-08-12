import { parseBluedartInvoiceText } from "../src/modules/connectors/bluedart/invoice.js";

// Bluedart bills as PDF, and `Shipment.freightAmount` has no other source — so
// this parser is the only path by which shipping cost, half of contribution
// margin, ever enters the system. Everything below is asserted against the
// exact line grammar three real invoices use.
//
// Run with: npx tsx scripts/checkBluedartInvoice.ts

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  if (condition) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const HEADER = [
  "Tax Invoice",
  "OJAS SOFTECH PRIVATE LIMITED",
  "NDA821166 (NDA)",
  "2026709R00005458",
  "Invoice Date : 31/07/2026",
  "Etail Air COD",
].join("\n");

function invoice(rows: string[], total?: string, grand?: string) {
  return [
    HEADER,
    ...rows,
    ...(total ? [`Total ${total}`] : []),
    ...(grand ? [`Grand Total ${grand}`] : []),
  ].join("\n");
}

function main() {
  console.log("\n[1] the real line grammar");
  const p = parseBluedartInvoiceText(
    invoice(
      [
        "01/07/2026 (R)80092970506 BENGALURU NDx 0.50 5.82\t1",
        "01/07/2026 (R)80092978464 GUWAHATI NDx 0.50 -86.67\t2",
        "01/07/2026 80108492236 GUWAHATI NDx 0.50 75.82\t3",
        "01/07/2026 80099937820 KARIMGANJ NDx 1.50 122.44\t4",
        "16/07/2026 80120054700 DOMBIVALI NDx 0.50 560.05\t5",
      ],
      "677.46"
    )
  );
  ok("parses every row", p.lines.length === 5, `got ${p.lines.length}`);
  ok("invoice number", p.invoiceNo === "2026709R00005458", p.invoiceNo);
  ok("customer account", p.customerAccount === "NDA821166", String(p.customerAccount));
  ok("product", p.product === "Etail Air COD", String(p.product));
  ok("invoice date is dd/MM/yyyy", p.invoiceDate?.toISOString().slice(0, 10) === "2026-07-31", String(p.invoiceDate));

  console.log("\n[2] money is exact integers, and signs survive");
  ok("5.82 → 582 paise", p.lines[0]!.amountPaise === 582n, String(p.lines[0]!.amountPaise));
  // A credit that lost its sign would understate cost by twice its value.
  ok("−86.67 stays negative", p.lines[1]!.amountPaise === -8667n, String(p.lines[1]!.amountPaise));
  ok("560.05 → 56005 paise", p.lines[4]!.amountPaise === 56005n, String(p.lines[4]!.amountPaise));
  ok("sum is exact", p.summedLinePaise === 582n - 8667n + 7582n + 12244n + 56005n, String(p.summedLinePaise));

  console.log("\n[3] the (R) return leg");
  ok("(R) sets isReturnLeg", p.lines[0]!.isReturnLeg === true);
  ok("plain row does not", p.lines[2]!.isReturnLeg === false);
  ok("(R) is stripped from the AWB", p.lines[0]!.awb === "80092970506", p.lines[0]!.awb);

  console.log("\n[4] dd/MM/yyyy, not the American reading");
  // 01/07 is 1 JULY. Read month-first it becomes 7 January — six months wrong,
  // and every freight cost lands in the wrong period.
  ok("01/07/2026 is 1 July", p.lines[0]!.shipDate.toISOString().slice(0, 10) === "2026-07-01", p.lines[0]!.shipDate.toISOString());
  ok("16/07/2026 is 16 July", p.lines[4]!.shipDate.toISOString().slice(0, 10) === "2026-07-16");

  console.log("\n[5] the checksum against Bluedart's own stated total");
  ok("matching total produces no warning", p.warnings.length === 0, p.warnings.join(" | "));
  const bad = parseBluedartInvoiceText(
    invoice(["01/07/2026 80108492236 GUWAHATI NDx 0.50 75.82\t1"], "999.99")
  );
  ok("mismatched total is reported", bad.warnings.some((w) => /total mismatch/.test(w)), bad.warnings.join(" | "));

  console.log("\n[6] rows that are not shipments are ignored");
  const noisy = parseBluedartInvoiceText(
    invoice(
      [
        "Page 1 of 10",
        "CGST @9% On Rs.129686.63 11,671.80",
        "Fuel Surcharge 42,291.94",
        "01/07/2026 80108492236 GUWAHATI NDx 0.50 75.82\t1",
        "IRN Date : 31/07/2026",
        "Terms and Conditions",
      ],
      "75.82"
    )
  );
  ok("only the shipment row is taken", noisy.lines.length === 1, `got ${noisy.lines.length}`);
  ok("tax and surcharge lines are not rows", noisy.summedLinePaise === 7582n, String(noisy.summedLinePaise));

  console.log("\n[7] destinations with spaces");
  const spaced = parseBluedartInvoiceText(
    invoice(
      [
        "01/07/2026 80095207916 MOTIHARI OFFICE NDx 0.50 17.48\t1",
        "01/07/2026 80101590601 MANDI NER CHOWK NDx 0.50 17.48\t2",
        "07/07/2026 80113103523 PURI EXPANSION NDx 0.50 81.65\t3",
      ],
      "116.61"
    )
  );
  ok("multi-word destinations survive", spaced.lines.length === 3, `got ${spaced.lines.length}`);
  ok("destination text is whole", spaced.lines[1]!.destination === "MANDI NER CHOWK", spaced.lines[1]!.destination);
  ok("weight parsed beside them", spaced.lines[2]!.chargedWeightKg === 0.5);

  console.log("\n[8] one AWB billed twice — outbound and return");
  const twice = parseBluedartInvoiceText(
    invoice(
      [
        "01/07/2026 80108492741 REWARI NDx 0.50 87.48\t1",
        "10/07/2026 (R)80108492741 REWARI NDx 0.50 17.48\t2",
      ],
      "104.96"
    )
  );
  // Both must survive: an RTO costs freight twice, and collapsing them would
  // halve the recorded cost of the most expensive kind of order there is.
  ok("both legs kept", twice.lines.length === 2, `got ${twice.lines.length}`);
  ok("they sum to both charges", twice.summedLinePaise === 10496n, String(twice.summedLinePaise));
  ok("one is flagged as the return", twice.lines.filter((l) => l.isReturnLeg).length === 1);

  console.log("\n[9] an exact duplicate row is dropped");
  const dupe = parseBluedartInvoiceText(
    invoice(
      [
        "01/07/2026 80108492236 GUWAHATI NDx 0.50 75.82\t1",
        "01/07/2026 80108492236 GUWAHATI NDx 0.50 75.82\t1",
      ],
      "75.82"
    )
  );
  ok("identical row deduped", dupe.lines.length === 1, `got ${dupe.lines.length}`);

  console.log("\n[10] a non-invoice PDF is refused, not half-read");
  const wrong = parseBluedartInvoiceText("Some other document\nwith no shipment rows at all\n");
  ok("no rows found", wrong.lines.length === 0);
  ok("and it says so", wrong.warnings.some((w) => /no shipment rows/.test(w)), wrong.warnings.join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main();
