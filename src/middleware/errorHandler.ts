import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger.js";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: "not_found", path: req.path });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "validation_error", issues: err.issues });
    return;
  }

  // body-parser rejects an oversized body before any route runs, and without
  // this it surfaced as a generic 500 "internal_error" — telling someone whose
  // statement export was too large that the server broke, when the actionable
  // truth is "split the file". Reported with the real status and the limit.
  const e = err as { type?: string; status?: number; limit?: number };
  if (e?.type === "entity.too.large") {
    res.status(413).json({
      error: "payload_too_large",
      limitBytes: e.limit ?? null,
      message: "That file is larger than this endpoint accepts. Split the export into smaller date ranges and upload them one at a time.",
    });
    return;
  }
  // Malformed JSON is the client's problem, not a server fault.
  if (e?.type === "entity.parse.failed") {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  logger.error({ err, path: req.path }, "unhandled_error");
  res.status(500).json({ error: "internal_error" });
}
