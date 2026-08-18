import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { lookupUsers } from "../../lib/clerkDirectory.js";
import { readPresence } from "../../middleware/sessionTracker.js";
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

/**
 * WHO IS USING THE DASHBOARD RIGHT NOW.
 *
 * THE GRANULARITY IS FIVE MINUTES AND THE PAGE SAYS SO. `lastSeenAt` is written
 * at most once per five minutes per user per process (see middleware/
 * userActivity.ts and the note on UserActivityDay) — a deliberate trade that
 * keeps an authenticated read from becoming an authenticated read plus a write.
 * The consequence is that this cannot tell you someone is on the page this
 * second, only that they were within the last few minutes. Presenting it as
 * live would be inventing precision the write path does not have.
 *
 * Names come from Clerk, not from here: `memberships` stores an email and no
 * name at all. A missing name is rendered as the email rather than as a blank —
 * see lib/clerkDirectory.ts for why identity is read rather than copied.
 *
 * WHAT THIS CANNOT ANSWER, and is not made to look like it can: which page
 * anyone is on. `request_metrics` is keyed by route and NOT by user, which is
 * exactly what stops it growing a row per person; joining the two would need
 * per-user request logging that does not exist.
 */
internalUsersRouter.get("/live", async (req, res) => {
  const minutes = Number(req.query.minutes) > 0 ? Math.min(Math.trunc(Number(req.query.minutes)), 1440) : 60;
  const cutoff = new Date(Date.now() - minutes * 60_000);

  const rows = await prisma.membership.findMany({
    where: { lastSeenAt: { gte: cutoff } },
    select: { clerkUserId: true, email: true, role: true, lastSeenAt: true, organizationId: true },
    orderBy: { lastSeenAt: "desc" },
    take: 200,
  });

  // Two queries rather than an include: Membership carries organizationId as a
  // plain column with no Prisma relation to Organization, which is what keeps
  // the tenant boundary explicit everywhere else in this codebase. Resolving
  // names separately preserves that rather than adding a relation for one panel.
  const [organizations, directory] = await Promise.all([
    prisma.organization.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.organizationId))] } },
      select: { id: true, name: true },
    }),
    lookupUsers(rows.map((r) => r.clerkUserId)),
  ]);
  const orgName = new Map(organizations.map((o) => [o.id, o.name]));
  const now = Date.now();

  res.json({
    windowMinutes: minutes,
    // Stated in the response, not only in the UI, so any other consumer of this
    // endpoint inherits the caveat rather than having to know it.
    granularitySeconds: 300,
    // One person in two organisations is two rows here and one human. Both
    // numbers are returned because "how many people" and "how many sessions
    // across tenants" are different questions and only one of them is people.
    activePeople: new Set(rows.map((r) => r.clerkUserId)).size,
    activeMemberships: rows.length,
    activeOrganizations: new Set(rows.map((r) => r.organizationId)).size,
    members: rows.map((r) => {
      const d = directory.get(r.clerkUserId);
      const seen = r.lastSeenAt?.getTime() ?? null;
      return {
        clerkUserId: r.clerkUserId,
        name: d?.name ?? null,
        email: d?.email ?? r.email,
        imageUrl: d?.imageUrl ?? null,
        organizationId: r.organizationId,
        organizationName: orgName.get(r.organizationId) ?? null,
        role: r.role,
        lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
        secondsSinceSeen: seen === null ? null : Math.round((now - seen) / 1000),
      };
    }),
  });
});

/** How the seven roles are distributed across every organisation. */
internalUsersRouter.get("/roles", async (_req, res) => {
  const rows = await prisma.membership.groupBy({ by: ["role"], _count: { _all: true } });
  res.json({ roles: rows.map((r) => ({ role: r.role, members: r._count._all })).sort((a, b) => b.members - a.members) });
});

/**
 * WHO IS ON THE PRODUCT RIGHT NOW — presence, not history.
 *
 * Read from REDIS, not Postgres, and that is the whole point of the endpoint.
 * /live above reads Membership.lastSeenAt, which is written at most once every
 * five minutes; a "live" panel built on it is up to five minutes behind and
 * cannot show somebody who signed in thirty seconds ago. This reads the key the
 * session tracker sets on every single authenticated request, so it is current
 * to the caller's last click.
 *
 * WHAT IT STILL CANNOT DO, said here so nobody expects otherwise: it sees
 * REQUESTS. A person reading a page and not clicking generates none and stops
 * moving. That ceiling belongs to the product, not the transport — which is why
 * the console polls this every few seconds instead of holding a websocket open
 * for an update that would not arrive any sooner.
 */
internalUsersRouter.get("/online", async (_req, res) => {
  const presence = await readPresence();
  const now = Date.now();

  // The durable rows carry everything the Redis key does not: where the address
  // resolves to, what browser, and — the one that matters — when this session
  // actually started, as opposed to when it was last used.
  const sessions = presence.length
    ? await prisma.userSession.findMany({ where: { clerkSessionId: { in: presence.map((p) => p.sessionId) } } })
    : [];
  const byId = new Map(sessions.map((s) => [s.clerkSessionId, s]));

  const userIds = [...new Set(presence.map((p) => p.userId))];
  const orgIds = [...new Set(presence.map((p) => p.organizationId).filter((x): x is string => x !== null))];
  const [directory, orgs] = await Promise.all([
    lookupUsers(userIds),
    orgIds.length ? prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  // "Have they been here from this country before" needs their history, not
  // just this session. One query for every user currently online.
  const priorCountries = userIds.length
    ? await prisma.userSession.groupBy({ by: ["clerkUserId", "countryCode"], where: { clerkUserId: { in: userIds } } })
    : [];
  const seenCountries = new Map<string, Set<string>>();
  for (const r of priorCountries) {
    if (!r.countryCode) continue;
    const set = seenCountries.get(r.clerkUserId) ?? new Set<string>();
    set.add(r.countryCode);
    seenCountries.set(r.clerkUserId, set);
  }

  const rows = presence
    .map((p) => {
      const s = byId.get(p.sessionId) ?? null;
      const person = directory.get(p.userId);
      const countries = seenCountries.get(p.userId);
      return {
        sessionId: p.sessionId,
        clerkUserId: p.userId,
        email: person?.email ?? null,
        name: person?.name ?? null,
        imageUrl: person?.imageUrl ?? null,
        organizationId: p.organizationId,
        organizationName: p.organizationId ? (orgName.get(p.organizationId) ?? null) : null,
        /** Seconds since their last request. Zero means they are clicking right now. */
        secondsSinceRequest: Math.max(0, Math.round((now - p.at) / 1000)),
        lastPath: p.path,
        signedInAt: s?.signedInAt.toISOString() ?? null,
        // FROM REDIS, not from the durable row. The Postgres count is written
        // at most once a minute and is therefore up to a minute behind; this
        // one is exact as of the caller's last request, which is the whole
        // reason this endpoint exists.
        requests: p.requests,
        /** The durable total, which lags. Shown apart so neither is mistaken for the other. */
        recordedRequests: s?.requests ?? null,
        ip: p.ip,
        /**
         * APPROXIMATE, and the field names say so nowhere so the console must.
         * IP geolocation is right about the country almost always and about the
         * city often enough to mislead — a mobile connection resolves to the
         * carrier's gateway, which is regularly in another state.
         */
        city: s?.city ?? null,
        region: s?.region ?? null,
        country: s?.country ?? null,
        countryCode: s?.countryCode ?? null,
        timezone: s?.timezone ?? null,
        network: s?.network ?? null,
        /** Probably a VPN or a bot. Inferred from the network's name, so a guess. */
        hosting: s?.hosting ?? null,
        browser: s?.browser ?? null,
        os: s?.os ?? null,
        deviceKind: s?.deviceKind ?? null,
        userAgent: s?.userAgent ?? null,
        /**
         * TRUE when this is the only country we have ever seen for them AND
         * they have more than one session on record — i.e. a genuinely new
         * place, not merely their first ever sign-in.
         */
        newCountryForUser:
          s?.countryCode != null && countries != null && countries.size > 1,
      };
    })
    .sort((a, b) => a.secondsSinceRequest - b.secondsSinceRequest);

  res.json({
    at: new Date().toISOString(),
    /** Sessions, not people: two browsers is two rows, deliberately. */
    sessions: rows.length,
    people: new Set(rows.map((r) => r.clerkUserId)).size,
    organizations: new Set(rows.map((r) => r.organizationId).filter(Boolean)).size,
    /** Presence expires on its own after this long without a request. */
    presenceTtlSeconds: 900,
    online: rows,
  });
});

/**
 * SIGN-IN HISTORY.
 *
 * One row per Clerk session, newest first. signedInAt is stamped once, when the
 * session id is first seen, and never updated — so this is a list of logins,
 * not a list of "most recent activity", which lastSeenAt already covers.
 */
internalUsersRouter.get("/sessions", async (req, res) => {
  const days = daysParam(req, 30, 365);
  const from = since(days * DAY_MS);

  const [rows, first] = await Promise.all([
    prisma.userSession.findMany({ where: { signedInAt: { gte: from } }, orderBy: { signedInAt: "desc" }, take: 300 }),
    prisma.userSession.findFirst({ orderBy: { signedInAt: "asc" }, select: { signedInAt: true } }),
  ]);

  const userIds = [...new Set(rows.map((r) => r.clerkUserId))];
  const orgIds = [...new Set(rows.map((r) => r.organizationId).filter((x): x is string => x !== null))];
  const [directory, orgs] = await Promise.all([
    lookupUsers(userIds),
    orgIds.length ? prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  // Which (user, country) pairs have been seen before this row. Computed over
  // the whole table rather than the window, so a sign-in from a country that is
  // new IN THIS WINDOW but familiar overall is not flagged as new.
  const everSeen = await prisma.userSession.groupBy({
    by: ["clerkUserId", "countryCode"],
    _min: { signedInAt: true },
  });
  const firstSeenIn = new Map(
    everSeen.filter((r) => r.countryCode).map((r) => [`${r.clerkUserId}|${r.countryCode}`, r._min.signedInAt?.getTime() ?? 0]),
  );

  res.json({
    windowDays: days,
    /** Recording began here. An empty list before this is absence, not calm. */
    recordingSince: first?.signedInAt.toISOString() ?? null,
    sessions: rows.map((r) => {
      const person = directory.get(r.clerkUserId);
      const key = `${r.clerkUserId}|${r.countryCode}`;
      return {
        id: r.id,
        clerkSessionId: r.clerkSessionId,
        clerkUserId: r.clerkUserId,
        email: person?.email ?? null,
        name: person?.name ?? null,
        imageUrl: person?.imageUrl ?? null,
        organizationId: r.organizationId,
        organizationName: r.organizationId ? (orgName.get(r.organizationId) ?? null) : null,
        signedInAt: r.signedInAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        requests: r.requests,
        ip: r.ip,
        city: r.city, region: r.region, country: r.country, countryCode: r.countryCode,
        timezone: r.timezone, network: r.network, hosting: r.hosting,
        browser: r.browser, os: r.os, deviceKind: r.deviceKind, userAgent: r.userAgent,
        /** This session is the FIRST this person ever signed in from that country. */
        firstFromThisCountry:
          r.countryCode != null && firstSeenIn.get(key) === r.signedInAt.getTime(),
      };
    }),
  });
});
