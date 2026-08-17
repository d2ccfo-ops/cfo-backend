import { Router } from "express";
import { prisma } from "../lib/prisma.js";

export const healthRouter = Router();

// WHICH COMMIT IS ANSWERING.
//
// A tag says v23. It does not say which source produced v23, and after a
// rebuild-and-retag the tag is actively misleading — on 2026-08-17 the console
// image was built from this directory by mistake and shipped under a tag that
// claimed otherwise, which cost four minutes of production and a confusing
// crash loop. Baked in by the Dockerfile at build time and read here, so the
// running container answers the question itself.
//
// "unknown" is the honest default for a container built without the build arg,
// and for `npm run dev`. It must not fall back to reading git at runtime: the
// working tree is not in the image, and the answer would be whatever the
// machine asking happened to have checked out.
const BUILD = {
  gitSha: process.env.GIT_SHA ?? "unknown",
  builtAt: process.env.BUILD_TIME ?? "unknown",
};

healthRouter.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "ok", ...BUILD });
  } catch {
    // The build identity is returned on the failure path too. The single most
    // useful thing to know about a container that cannot reach its database is
    // which build it is.
    res.status(503).json({ status: "degraded", db: "unreachable", ...BUILD });
  }
});
