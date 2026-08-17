import { Router } from "express";
import { computeCloudCost } from "../../modules/observability/cloudCost.js";

export const internalEconomicsRouter = Router();

/**
 * What GCP charges, priced from the inventory that actually exists.
 *
 * NOT AN INVOICE, and the response says so in a field rather than only in a
 * comment: `isInvoice: false` plus an explicit `excludes` list travel with the
 * number, so a caller cannot render the total without also having the
 * caveats. The billed truth needs the Cloud Billing export to BigQuery, which
 * this project does not have configured.
 */
internalEconomicsRouter.get("/cloud", async (_req, res) => {
  res.json(await computeCloudCost());
});
