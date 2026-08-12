import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";

const app = createApp();

// Last-resort net for rejections outside the request cycle (fire-and-forget
// syncs, timers), which express-async-errors cannot reach. Log loudly and keep
// serving — one background failure must not take the API down for every page.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled_rejection");
});

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "cfo-backend listening");
});
