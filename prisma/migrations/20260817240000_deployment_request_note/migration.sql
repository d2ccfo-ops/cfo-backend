-- What the post-deploy health gate observed, on the SUCCESS path. Kept apart
-- from `error` because "applied and verified" and "applied but the gate was
-- skipped" are both successes carrying very different assurance, and putting
-- either in `error` would render a green row red.
ALTER TABLE "deployment_requests" ADD COLUMN "note" TEXT;
