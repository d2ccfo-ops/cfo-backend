import { Router } from "express";
import { requireSuperAdmin } from "../../middleware/requireSuperAdmin.js";
import { internalAiRouter } from "./ai.js";
import { internalInfraRouter } from "./infra.js";
import { internalJobsRouter } from "./jobs.js";
import { internalOverviewRouter } from "./overview.js";
import { internalTenantsRouter } from "./tenants.js";
import { internalUsersRouter } from "./users.js";

// The operations console's API. Cross-tenant, and therefore fenced off from
// everything else in this app.
//
// requireSuperAdmin is applied HERE, once, with router.use — the opposite of
// the rule calcCache follows two directories over, and for the opposite reason.
// There, a blanket middleware was dangerous because it would silently start
// caching endpoints added later. Here, a blanket middleware is the only safe
// arrangement, because the thing that would be applied by omission is
// AUTHORISATION: a route added to this router tomorrow and accidentally left
// off a per-route guard list would be an unauthenticated cross-tenant read of
// every customer's data. The failure mode of forgetting must be "denied", not
// "wide open", and only router.use gives that.
//
// Nothing under here may write. Every handler is a GET, deliberately: an
// operator console that can also change things is an audit problem and a much
// larger blast radius, and nothing on the console needs it.
export const internalRouter = Router();

internalRouter.use(requireSuperAdmin);

internalRouter.use("/overview", internalOverviewRouter);
internalRouter.use("/ai", internalAiRouter);
internalRouter.use("/infra", internalInfraRouter);
internalRouter.use("/jobs", internalJobsRouter);
internalRouter.use("/tenants", internalTenantsRouter);
internalRouter.use("/users", internalUsersRouter);
