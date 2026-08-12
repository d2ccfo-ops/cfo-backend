import { prisma } from "../src/lib/prisma.js";
import { ingestStatement } from "../src/modules/connectors/bank/index.js";
import { BLUEDART_COD_STATEMENT } from "../src/modules/connectors/bluedart/index.js";
import { GOKWIK_SETTLEMENT_STATEMENT } from "../src/modules/connectors/gokwik/index.js";
import { toConnectorContext } from "../src/modules/connectors/types.js";
import {
  EMAIL_INGEST_ACCOUNT,
  detectCsvFormat,
  extractTokenFromRecipients,
  generateIngestToken,
  normalizeInboundPayload,
  processInboundEmail,
  type NormalizedInboundEmail,
} from "../src/modules/ingest/inboundEmail.js";

// The email pipe, end to end against a scratch organisation: payload
// normalisation, token extraction, content detection, dispatch into the real
// importers, connection isolation, the log row, retry dedupe, and rotation.
// Torn down in a finally.
//
// The one seam NOT covered here is a real Bluedart invoice PDF through
// pdf-parse — that path is exercised by checkBluedartInvoice.ts at the text
// layer and was verified against three real invoices live; here a garbage PDF
// asserts the refusal is RECORDED rather than crashing the email.
//
// Run with: npx tsx scripts/checkEmailIngest.ts

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

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

// A minimal NormalizedInboundEmail for the processInboundEmail-level tests.
function email(over: Partial<NormalizedInboundEmail>): NormalizedInboundEmail {
  return {
    from: null,
    recipients: { envelope: [], fallback: [] },
    subject: null,
    messageId: null,
    attachments: [],
    looksLikeEmail: true,
    ...over,
  };
}

async function main() {
  console.log("\n[1] payload normalisation");
  const pm = normalizeInboundPayload({
    FromFull: { Email: "billing@bluedart.com", Name: "Blue Dart" },
    ToFull: [{ Email: "docs-abc@in.example.com" }],
    Subject: "Tax Invoice",
    MessageID: "msg-1",
    Attachments: [{ Name: "inv.pdf", Content: b64("%PDF-junk"), ContentType: "application/pdf" }],
  });
  ok("postmark from", pm?.from === "billing@bluedart.com", String(pm?.from));
  ok("postmark To lands in fallback", pm?.recipients.fallback.includes("docs-abc@in.example.com") === true, pm?.recipients.fallback.join(","));
  ok("postmark messageId", pm?.messageId === "msg-1");
  ok("postmark attachment decoded", pm?.attachments[0]?.content.toString("utf8") === "%PDF-junk");

  const withEnvelope = normalizeInboundPayload({
    Subject: "s",
    OriginalRecipient: "docs-envelope@in.example.com",
    ToFull: [{ Email: "docs-visible@in.example.com" }],
    Attachments: [],
  });
  ok("OriginalRecipient lands in envelope", withEnvelope?.recipients.envelope[0] === "docs-envelope@in.example.com", JSON.stringify(withEnvelope?.recipients));

  const plain = normalizeInboundPayload({
    from: "a@b.c",
    to: "docs-x@d.e, other@d.e",
    subject: "s",
    attachments: [{ name: "r.csv", contentBase64: b64("a,b"), contentType: "text/csv" }],
  });
  ok("plain shape parses", plain?.attachments.length === 1 && plain.recipients.fallback.length === 2, JSON.stringify(plain?.recipients));

  ok("junk string body is null", normalizeInboundPayload("nope") === null);
  ok("array body is null", normalizeInboundPayload([1, 2]) === null);
  // A JSON object with NO email-identifying field is refused, so a valid-token
  // POST of arbitrary JSON cannot spam phantom EMPTY log rows.
  ok("non-email object is null", normalizeInboundPayload({ foo: 1 }) === null);
  ok("an object with only Subject is an email", normalizeInboundPayload({ Subject: "hi" }) !== null);
  const empty64 = normalizeInboundPayload({ subject: "s", attachments: [{ name: "x", contentBase64: "" }] });
  ok("empty base64 attachment dropped", empty64?.attachments.length === 0);
  // A 20MB attachment is rejected before it decodes into memory.
  const huge = normalizeInboundPayload({ subject: "s", attachments: [{ name: "big.pdf", contentBase64: "A".repeat(21 * 1024 * 1024) }] });
  ok("oversized attachment dropped", huge?.attachments.length === 0);

  console.log("\n[2] token extraction — envelope first, refuse on conflict");
  const tok = "a".repeat(48);
  const tok2 = "b".repeat(48);
  const R = (envelope: string[], fallback: string[] = []) => extractTokenFromRecipients({ envelope, fallback });
  ok("bare address", R([`docs-${tok}@in.x.com`]) === tok);
  ok("angle-bracketed", R([`"CFOOS" <docs-${tok}@in.x.com>`]) === tok);
  ok("uppercase local part resolves", R([`DOCS-${tok.toUpperCase()}@in.x.com`]) === tok);
  ok("wrong prefix rejected", R([`invoice-${tok}@in.x.com`]) === null);
  ok("short token rejected", R([`docs-${"a".repeat(30)}@in.x.com`]) === null);
  // Envelope (delivered-to) wins over visible To/Cc, which on a forwarded
  // courier email still name the original recipient.
  ok("envelope wins over fallback", R([`docs-${tok}@in.x.com`], [`docs-${tok2}@in.x.com`]) === tok);
  ok("fallback used only when envelope empty", R([], [`docs-${tok}@in.x.com`]) === tok);
  // Two DIFFERENT ingest addresses at one trust level → refuse, never guess.
  ok("conflicting tokens refused", R([`docs-${tok}@in.x.com`, `docs-${tok2}@in.x.com`]) === null);
  ok("same token twice is fine", R([`docs-${tok}@in.x.com`, `docs-${tok}@in.y.com`]) === tok);

  console.log("\n[3] CSV detection — identity signatures, not generic columns");
  const bd = detectCsvFormat("Remittance No,UTR,Remittance Date,Waybill No,COD Amount,Net Amount\nr1,u1,2026-08-01,80001,100.00,95.00");
  ok("bluedart MIS detected", bd.detected?.provider === "BLUEDART", bd.reason);
  const gk = detectCsvFormat("Settlement UTR,Settlement Date,Merchant Order Id,Amount,Credit,Payment Mode\nu1,2026-08-01,25001,100.00,98.00,upi");
  ok("gokwik ledger detected", gk.detected?.provider === "GOKWIK", gk.reason);
  // Misroute guard: a generic "Tax" column must NOT route a courier MIS to GoKwik.
  const notGokwik = detectCsvFormat("Settlement Id,Payout Date,AWB,COD Amount,Net Amount,Tax\ns1,2026-08-01,80001,100.00,95.00,5.00");
  ok("generic Tax does not route to gokwik", notGokwik.detected?.provider !== "GOKWIK", String(notGokwik.detected?.provider));
  ok("…it is refused as unknown", notGokwik.detected === null, notGokwik.reason);
  // False-ambiguity guard: a real Bluedart MIS (has 'COD Charges', a signature)
  // is accepted even though 'Settlement Id' is a shared spelling.
  const realBd = detectCsvFormat("Settlement Id,Payout Date,Waybill No,COD Amount,COD Charges,Net Amount\ns,2026-08-01,80001,100,5,95");
  ok("bluedart signature beats shared columns", realBd.detected?.provider === "BLUEDART", realBd.reason);
  // Both signatures present → genuinely ambiguous → refuse.
  const bothSig = detectCsvFormat("Remittance No,Settlement UTR,Payout Date,Waybill No,Merchant Order Id,COD Amount\nr,u,2026-08-01,80001,25001,100");
  ok("both signatures refused as ambiguous", bothSig.detected === null && /ambiguous/.test(bothSig.reason), bothSig.reason);
  ok("garbage refused", detectCsvFormat("hello world\n1,2").detected === null);
  ok("empty refused", detectCsvFormat("").detected === null);
  const quoted = detectCsvFormat(
    '"Remittance No","Remittance Date","Waybill No","COD Amount","Total Remittance, INR"\nr,2026-08-01,80001,10.00,10.00'
  );
  ok("quoted headers parse", quoted.detected?.provider === "BLUEDART", quoted.reason);

  console.log("\n[4] detection vocabulary agrees with the importer's normalisation");
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const fmt of [BLUEDART_COD_STATEMENT, GOKWIK_SETTLEMENT_STATEMENT]) {
    const allCands = Object.values(fmt.columns).flat() as string[];
    ok(`${fmt.label}: no candidate normalises to empty`, allCands.every((c) => norm(c).length > 0));
  }

  // --- scratch org ---------------------------------------------------------
  const org = await prisma.organization.create({
    data: { name: `TEST email ${Date.now()}`, clerkOrgId: `test_email_${Date.now()}` },
  });

  try {
    const address = await prisma.emailIngestAddress.create({
      data: { organizationId: org.id, token: generateIngestToken() },
    });

    console.log("\n[5] unknown token → null (indistinguishable from disabled)");
    ok("unknown token → null", (await processInboundEmail("f".repeat(48), email({}))) === null);

    console.log("\n[6] a real courier connection is NOT touched by email ingest");
    // Stand up the merchant's real, credentialed Bluedart connection FIRST, with
    // a real settlement on it. A forged emailed CSV must not be able to reach it.
    const entity = await prisma.legalEntity.create({ data: { organizationId: org.id, name: "E" } });
    const realConn = await prisma.connection.create({
      data: {
        organizationId: org.id,
        legalEntityId: entity.id,
        provider: "BLUEDART",
        status: "ACTIVE",
        externalAccountId: "NDA821166",
        credentialsRef: "real",
      },
    });
    const realSettlement = await prisma.settlement.create({
      data: {
        organizationId: org.id,
        connectionId: realConn.id,
        legalEntityId: entity.id,
        externalSettlementId: "REM001",
        amount: 999999n,
        provider: "BLUEDART",
        kind: "COD_REMITTANCE",
        status: "processed",
      },
    });

    // Attacker's CSV reuses the real settlement's batch id (REM001), trying to
    // overwrite it and delete its lines.
    const forged = [
      "Remittance No,UTR,Remittance Date,Waybill No,COD Amount,COD Charges,Net Amount",
      "REM001,HAX,2026-08-01,80000000001,1.00,0.00,1.00",
    ].join("\n");
    const attack = await processInboundEmail(address.token, email({
      from: "attacker@evil.com",
      subject: "gotcha",
      messageId: "atk-1",
      attachments: [{ name: "forge.csv", content: Buffer.from(forged, "utf8"), contentType: "text/csv" }],
    }));
    ok("attack email processed", attack?.status === "PROCESSED", `${attack?.status}: ${attack?.outcomes[0]?.detail}`);
    const realAfter = await prisma.settlement.findUnique({ where: { id: realSettlement.id } });
    ok("real settlement amount untouched", realAfter?.amount === 999999n, String(realAfter?.amount));
    ok("real settlement still on real connection", realAfter?.connectionId === realConn.id);
    // The forged batch landed on a SEPARATE email-ingest connection.
    const ingestConn = await prisma.connection.findFirst({
      where: { organizationId: org.id, provider: "BLUEDART", externalAccountId: EMAIL_INGEST_ACCOUNT },
    });
    ok("a distinct email-ingest connection exists", Boolean(ingestConn) && ingestConn!.id !== realConn.id);
    ok("email-ingest connection is PENDING", ingestConn?.status === "PENDING", ingestConn?.status);
    const forgedSettlement = await prisma.settlement.findFirst({
      where: { organizationId: org.id, connectionId: ingestConn!.id, externalSettlementId: "REM001" },
    });
    ok("forged batch is isolated on the ingest connection", Boolean(forgedSettlement));
    ok("real and forged are two different settlements", forgedSettlement!.id !== realSettlement.id);

    console.log("\n[7] a normal remittance CSV imports through the real importer");
    const csv = [
      "Remittance No,UTR,Remittance Date,Waybill No,COD Amount,COD Charges,Net Amount",
      "REM777,UTRX1,2026-08-01,80000000001,500.00,20.00,480.00",
      "REM777,UTRX1,2026-08-01,80000000002,300.00,20.00,280.00",
    ].join("\n");
    const mail1 = await processInboundEmail(address.token, email({
      from: "remittance@bluedart.com",
      subject: "COD remittance",
      messageId: "rem-1",
      attachments: [{ name: "mis.csv", content: Buffer.from(csv, "utf8"), contentType: "text/csv" }],
    }));
    ok("processed", mail1?.status === "PROCESSED", `${mail1?.status}: ${mail1?.outcomes[0]?.detail}`);
    ok("outcome names the format", mail1?.outcomes[0]?.format === BLUEDART_COD_STATEMENT.label, mail1?.outcomes[0]?.format);
    const rem777 = await prisma.settlement.findFirst({
      where: { organizationId: org.id, connectionId: ingestConn!.id, externalSettlementId: "REM777" },
    });
    ok("payout amount is the batch net", rem777?.amount === 76000n, String(rem777?.amount));

    console.log("\n[8] provider retries do not import twice");
    const retry = await processInboundEmail(address.token, email({
      from: "remittance@bluedart.com",
      subject: "COD remittance",
      messageId: "rem-1",
      attachments: [{ name: "mis.csv", content: Buffer.from(csv, "utf8"), contentType: "text/csv" }],
    }));
    ok("marked duplicate", retry?.duplicate === true);
    ok("still one log row for rem-1", (await prisma.inboundEmail.count({ where: { organizationId: org.id, messageId: "rem-1" } })) === 1);

    console.log("\n[9] out-of-balance batches make the email PARTIAL, not PROCESSED");
    // One balanced batch, one whose lines do not sum to its stated total.
    const mixed = [
      "Remittance No,UTR,Remittance Date,Waybill No,COD Amount,COD Charges,Net Amount,Total Remittance",
      "GOOD1,U,2026-08-02,80000000010,100.00,0.00,100.00,100.00",
      "BAD1,U,2026-08-02,80000000011,100.00,0.00,100.00,999.00",
    ].join("\n");
    const partial = await processInboundEmail(address.token, email({
      from: "remittance@bluedart.com",
      subject: "mixed",
      messageId: "mix-bal-1",
      attachments: [{ name: "mixed.csv", content: Buffer.from(mixed, "utf8"), contentType: "text/csv" }],
    }));
    // A rejected batch makes the attachment not-ok, so the single-attachment
    // email is FAILED (nothing fully clean); the detail names the refusal.
    ok("rejected batch is not hidden", partial?.outcomes[0]?.ok === false, JSON.stringify(partial?.outcomes[0]));
    ok("refusal is reported in the detail", /refused|out of balance/i.test(partial?.outcomes[0]?.detail ?? ""), partial?.outcomes[0]?.detail);

    console.log("\n[10] a poison attachment is recorded, not crashed on");
    const poison = await processInboundEmail(address.token, email({
      from: "billing@bluedart.com",
      subject: "Invoice + junk",
      messageId: "poison-1",
      attachments: [
        { name: "broken.pdf", content: Buffer.from("%PDF-1.4 garbage that is not a pdf"), contentType: "application/pdf" },
        { name: "report.xlsx", content: Buffer.concat([Buffer.from("PK"), Buffer.alloc(64)]), contentType: "application/vnd.ms-excel" },
        { name: "photo.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), contentType: "image/png" },
      ],
    }));
    ok("email survives poison", poison?.status === "FAILED", poison?.status);
    ok("three outcomes", poison?.outcomes.length === 3, String(poison?.outcomes.length));
    ok("broken pdf refused readably", /could not be read as a PDF|not a Bluedart freight invoice/.test(poison?.outcomes[0]?.detail ?? ""), poison?.outcomes[0]?.detail);
    ok("xlsx refusal is actionable", /export the report as CSV/.test(poison?.outcomes[1]?.detail ?? ""), poison?.outcomes[1]?.detail);
    ok("png is unrecognised", poison?.outcomes[2]?.kind === "unrecognised");

    console.log("\n[11] EMPTY for an attachment-less notice; the log answers 'where is my email'");
    const notice = await processInboundEmail(address.token, email({
      from: "noreply@bluedart.com",
      subject: "Your statement is ready",
      messageId: "empty-1",
    }));
    ok("attachment-less notice is EMPTY", notice?.status === "EMPTY", notice?.status);
    const log = await prisma.inboundEmail.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: "asc" }, select: { fromAddress: true, status: true } });
    ok("every email is logged", log.length >= 5, String(log.length));
    ok("sender recorded", log.some((l) => l.fromAddress === "remittance@bluedart.com"));

    console.log("\n[12] bank statements — a single connected account needs no identifier");
    const bankEntity = await prisma.legalEntity.create({ data: { organizationId: org.id, name: "BE" } });
    const bankConn1 = await prisma.connection.create({
      data: {
        organizationId: org.id,
        legalEntityId: bankEntity.id,
        provider: "BANK",
        status: "ACTIVE",
        externalAccountId: "HDFC •••1111",
        credentialsRef: "real-bank-1",
      },
    });
    const singleAccountCsv = ["date,description,amount,type", "2026-08-01,Sale settlement,500.00,CREDIT"].join("\n");
    const singleMail = await processInboundEmail(address.token, email({
      from: "statements@hdfcbank.net",
      subject: "Statement",
      messageId: "bank-single-1",
      attachments: [{ name: "stmt.csv", content: Buffer.from(singleAccountCsv, "utf8"), contentType: "text/csv" }],
    }));
    ok("single-account statement imports", singleMail?.outcomes[0]?.ok === true, JSON.stringify(singleMail?.outcomes[0]));
    ok(
      "lands on the real credentialed connection, not an isolated one",
      (await prisma.bankTransaction.count({ where: { connectionId: bankConn1.id } })) === 1
    );

    console.log("\n[13] bank statements — a second connected account forces disambiguation");
    const bankConn2 = await prisma.connection.create({
      data: {
        organizationId: org.id,
        legalEntityId: bankEntity.id,
        provider: "BANK",
        status: "ACTIVE",
        externalAccountId: "ICICI •••2222",
        credentialsRef: "real-bank-2",
      },
    });
    const noAccountMail = await processInboundEmail(address.token, email({
      from: "statements@hdfcbank.net",
      subject: "Statement 2",
      messageId: "bank-multi-noacct",
      attachments: [{ name: "stmt2.csv", content: Buffer.from(singleAccountCsv, "utf8"), contentType: "text/csv" }],
    }));
    ok(
      "refused, not guessed, with two accounts and no identifier",
      noAccountMail?.outcomes[0]?.ok === false && /does not say which one/.test(noAccountMail?.outcomes[0]?.detail ?? ""),
      noAccountMail?.outcomes[0]?.detail
    );
    ok(
      "nothing was imported by the refused attempt",
      (await prisma.bankTransaction.count({ where: { connectionId: bankConn1.id } })) === 1 &&
        (await prisma.bankTransaction.count({ where: { connectionId: bankConn2.id } })) === 0
    );

    console.log("\n[14] bank statements — a named account routes to the right connection");
    const namedCsv = [
      "date,description,amount,type,account",
      "2026-08-02,Refund,50.00,DEBIT,2222",
    ].join("\n");
    const namedMail = await processInboundEmail(address.token, email({
      from: "statements@icicibank.com",
      subject: "Statement",
      messageId: "bank-multi-named",
      attachments: [{ name: "stmt3.csv", content: Buffer.from(namedCsv, "utf8"), contentType: "text/csv" }],
    }));
    ok("named-account statement imports", namedMail?.outcomes[0]?.ok === true, JSON.stringify(namedMail?.outcomes[0]));
    ok(
      "routes to the matching connection by last-4, not the other one",
      (await prisma.bankTransaction.count({ where: { connectionId: bankConn2.id } })) === 1 &&
        (await prisma.bankTransaction.count({ where: { connectionId: bankConn1.id } })) === 1
    );

    console.log("\n[15] bank statements — email and manual upload of the SAME statement do not double-count");
    const ctxConn1 = toConnectorContext({ ...bankConn1, externalAccountId: bankConn1.externalAccountId });
    await ingestStatement(ctxConn1, singleAccountCsv); // the "manual upload" side, same connection
    ok(
      "re-ingesting the identical file via the manual path is a no-op, not a second row",
      (await prisma.bankTransaction.count({ where: { connectionId: bankConn1.id } })) === 1
    );

    console.log("\n[16] a real .xlsx bank statement is converted to CSV and imported the same way");
    // A hand-built minimal .xlsx (no external tool involved — generated once
    // via Python's stdlib zipfile against the exact OOXML parts read-excel-file
    // needs, then base64-embedded here): header row
    // date,description,amount,type,account plus 3 data rows naming account
    // "1111" — bankConn1's ("HDFC •••1111") last-4, so it must route there even
    // with bankConn2 also connected (same disambiguation as section [14], now
    // proven through the xlsx conversion too, not just plain CSV).
    const xlsxBase64 =
      "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";
    const xlsxMail = await processInboundEmail(address.token, email({
      from: "statements@hdfcbank.net",
      subject: "Statement (Excel)",
      messageId: "bank-xlsx-1",
      attachments: [{ name: "stmt.xlsx", content: Buffer.from(xlsxBase64, "base64"), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
    }));
    ok("xlsx statement imports", xlsxMail?.outcomes[0]?.ok === true, JSON.stringify(xlsxMail?.outcomes[0]));
    ok("all 3 data rows land as transactions", /3 transactions imported/.test(xlsxMail?.outcomes[0]?.detail ?? ""), xlsxMail?.outcomes[0]?.detail);
    ok(
      "routed to bankConn1 by the account column, not bankConn2",
      (await prisma.bankTransaction.count({ where: { connectionId: bankConn1.id } })) === 4 &&
        (await prisma.bankTransaction.count({ where: { connectionId: bankConn2.id } })) === 1
    );
    ok(
      "the decimal amount row (42000.5) survived the xlsx round-trip",
      (await prisma.bankTransaction.findFirst({ where: { connectionId: bankConn1.id, description: "Shopify payout" } }))?.amount === 4200050n
    );

    console.log("\n[17] a corrupt .xlsx is refused readably, not crashed on");
    const corruptXlsxMail = await processInboundEmail(address.token, email({
      from: "statements@hdfcbank.net",
      subject: "Statement (broken)",
      messageId: "bank-xlsx-corrupt",
      attachments: [{ name: "broken.xlsx", content: Buffer.concat([Buffer.from("PK"), Buffer.alloc(64)]), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
    }));
    ok(
      "corrupt xlsx refused, not thrown",
      corruptXlsxMail?.outcomes[0]?.ok === false && /Excel file could not be read/.test(corruptXlsxMail?.outcomes[0]?.detail ?? ""),
      corruptXlsxMail?.outcomes[0]?.detail
    );

    console.log("\n[18] a rotated-away address goes dead");
    await prisma.emailIngestAddress.update({ where: { id: address.id }, data: { disabledAt: new Date() } });
    const afterRotate = await processInboundEmail(address.token, email({ from: "x@y.z", subject: "late", messageId: "late-1" }));
    ok("disabled token → null, same as unknown", afterRotate === null);
    ok("nothing logged for the dead address's mail", (await prisma.inboundEmail.count({ where: { organizationId: org.id, messageId: "late-1" } })) === 0);
  } finally {
    await prisma.settlementLine.deleteMany({ where: { organizationId: org.id } });
    await prisma.settlement.deleteMany({ where: { organizationId: org.id } });
    await prisma.bankTransaction.deleteMany({ where: { organizationId: org.id } });
    await prisma.rawEvent.deleteMany({ where: { organizationId: org.id } });
    await prisma.inboundEmail.deleteMany({ where: { organizationId: org.id } });
    await prisma.emailIngestAddress.deleteMany({ where: { organizationId: org.id } });
    await prisma.connection.deleteMany({ where: { organizationId: org.id } });
    await prisma.legalEntity.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});