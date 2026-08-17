import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { daysParam, since } from "./shared.js";

export const internalUsersRouter = Router();

const DAY_MS = 24 * 60 * 60_000;

/**
 * Who is actually using this.
 *
 * Two sources, doing two different jobs:
 *   * user_activity_days gives a real daily series, because it records presence
 *     per day and is never overwritten.
 *   * Membership.lastSeenAt gives the current roster state — who is here now,
 *     who has gone quiet — which the daily table cannot answer without scanning
 *     every day in the window.
 *
 * Both start empty. Neither backfills, and neither should pretend to: every
 * figure here begins at the moment the instrumentation shipped, and a window
 * reaching further back than that is reporting a smaller product, not a
 * quieter one. `coverageFrom` is returned so a caller can draw that boundary.
 */
internalUsersRouter.get("/activity", async (req, res) => {
  const days = daysParam(req, 30);
  const from = since(days * DAY_MS);
  const fromDay = from.toISOString().slice(0, 10);

  const [daily, earliest, dau, wau, mau, totalMembers] = await Promise.all([
    prisma.$queryRaw<Array<{ day: string; users: bigint; orgs: bigint }>>`
      SELECT day,
             COUNT(DISTINCT "clerkUserId") AS users,
             COUNT(DISTINCT "organizationId") AS orgs
      FROM user_activity_days
      WHERE day >= ${fromDay}
      GROUP BY day
      ORDER BY day
    `,
    prisma.userActivityDay.findFirst({ orderBy: { day: "asc" }, select: { day: true } }),
    prisma.membership.count({ where: { lastSeenAt: { gte: since(DAY_MS) } } }),
    prisma.membership.count({ where: { lastSeenAt: { gte: since(7 * DAY_MS) } } }),
    prisma.membership.count({ where: { lastSeenAt: { gte: since(30 * DAY_MS) } } }),
    prisma.membership.count(),
  ]);

  res.json({
    windowDays: days,
    // The first day any activity was recorded. A window starting before this
    // is measuring the instrumentation, not the product.
    coverageFrom: earliest?.day ?? null,
    daily: daily.map((d) => ({ day: d.day, users: Number(d.users), organizations: Number(d.orgs) })),
    current: {
      dau,
      wau,
      mau,
      totalMembers,
      // DAU/MAU. The conventional stickiness ratio; null rather than 0 when
      // there is no denominator, because "nobody is sticky" and "nobody has
      // signed up" are different states.
      stickiness: mau === 0 ? null : dau / mau,
      // Members who have never made an authenticated request since this
      // shipped. Not the same as inactive — it includes everyone who was last
      // here before instrumentation existed.
      neverSeen: totalMembers - mau,
    },
  });
});

/** The roster, most recently active first. */
internalUsersRouter.get("/members", async (req, res) => {
  const days = daysParam(req, 30);
  const cutoff = since(days * DAY_MS);

  const members = await prisma.membership.findMany({
    select: { id: true, organizationId: true, clerkUserId: true, email: true, role: true, createdAt: true, lastSeenAt: true },
    orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }],
    take: 500,
  });

  const activeDays = await prisma.userActivityDay.groupBy({
    by: ["organizationId", "clerkUserId"],
    where: { lastSeenAt: { gte: cutoff } },
    _count: { _all: true },
  });
  const daysActive = new Map(activeDays.map((a) => [`${a.organizationId}|${a.clerkUserId}`, a._count._all]));

  const now = Date.now();
  res.json({
    windowDays: days,
    members: members.map((m) => ({
      organizationId: m.organizationId,
      clerkUserId: m.clerkUserId,
      email: m.email,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
      lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
      daysSinceSeen: m.lastSeenAt === null ? null : Math.floor((now - m.lastSeenAt.getTime()) / DAY_MS),
      daysActiveInWindow: daysActive.get(`${m.organizationId}|${m.clerkUserId}`) ?? 0,
    })),
  });
});

/** How the seven roles are distributed across every organisation. */
internalUsersRouter.get("/roles", async (_req, res) => {
  const rows = await prisma.membership.groupBy({ by: ["role"], _count: { _all: true } });
  res.json({ roles: rows.map((r) => ({ role: r.role, members: r._count._all })).sort((a, b) => b.members - a.members) });
});
