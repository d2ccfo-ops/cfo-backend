import { createClerkClient } from "@clerk/express";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

// NAMES AND FACES, WHICH THIS DATABASE DOES NOT HAVE.
//
// `memberships` stores an email and nothing else about a person — no first
// name, no last name, no avatar. That is the right shape for the product (the
// app never needed to render a name) and the wrong shape for an operations
// console, where "hritik@… was here 4 minutes ago" is a materially worse answer
// than "Hritik Kumar (hritik@…) was here 4 minutes ago".
//
// The alternative was a `name` column on Membership, populated on sign-in. It
// was rejected: it adds a write path to keep in sync forever, and it goes stale
// silently the moment someone changes their name in Clerk. Clerk is the system
// of record for identity, so identity is read from Clerk.
//
// WHAT MAKES THAT AFFORDABLE is that this is only ever called with a small,
// bounded set of ids — the people active in the last hour, or the handful with
// console access — never the whole user base, and the answers are cached. Clerk
// rate-limits its Backend API (100 requests / 10s on development instances), and
// a console page that fanned out one lookup per row would find that ceiling
// quickly.
//
// Every failure here degrades to a null name rather than an error: a directory
// outage must cost the console a column, not a page.

const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

/** Clerk's own ceiling on a single getUserList page. */
const MAX_PER_LOOKUP = 100;
const CACHE_TTL_MS = 5 * 60_000;

export interface DirectoryEntry {
  clerkUserId: string;
  name: string | null;
  email: string | null;
  imageUrl: string | null;
  /** Clerk's own view of last activity. Independent of our lastSeenAt. */
  lastActiveAt: string | null;
  banned: boolean;
}

const cache = new Map<string, { at: number; entry: DirectoryEntry }>();

function displayName(first: string | null, last: string | null): string | null {
  const name = [first, last].filter((p) => p && p.trim().length > 0).join(" ").trim();
  return name.length > 0 ? name : null;
}

/**
 * Look up several people at once.
 *
 * Returns a map rather than an array so a caller can enrich rows without
 * worrying about order or about ids Clerk did not return — a deleted account
 * is simply absent, and the caller renders the email it already had.
 */
export async function lookupUsers(userIds: string[]): Promise<Map<string, DirectoryEntry>> {
  const out = new Map<string, DirectoryEntry>();
  const now = Date.now();
  const misses: string[] = [];

  for (const id of new Set(userIds)) {
    const hit = cache.get(id);
    if (hit && now - hit.at < CACHE_TTL_MS) out.set(id, hit.entry);
    else misses.push(id);
  }
  if (misses.length === 0) return out;

  // Chunked, because getUserList takes a bounded list and a console showing a
  // busy hour can legitimately ask about more people than fit in one page.
  for (let i = 0; i < misses.length; i += MAX_PER_LOOKUP) {
    const chunk = misses.slice(i, i + MAX_PER_LOOKUP);
    try {
      const page = await clerk.users.getUserList({ userId: chunk, limit: MAX_PER_LOOKUP });
      for (const u of page.data) {
        const entry: DirectoryEntry = {
          clerkUserId: u.id,
          name: displayName(u.firstName, u.lastName),
          email:
            u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress ??
            u.emailAddresses[0]?.emailAddress ??
            null,
          imageUrl: u.imageUrl || null,
          lastActiveAt: u.lastActiveAt ? new Date(u.lastActiveAt).toISOString() : null,
          banned: u.banned,
        };
        cache.set(u.id, { at: now, entry });
        out.set(u.id, entry);
      }
    } catch (err) {
      // A column, not a page. Callers render what the database already knows.
      logger.warn({ err, count: chunk.length }, "clerk_directory_lookup_failed");
    }
  }

  return out;
}

/**
 * Resolve one person by email address, for granting console access.
 *
 * Returns null for "no such account", which the caller must report as exactly
 * that. Creating the user, or storing the typed email as though it resolved,
 * would produce a grant that authorises nobody and looks like it worked.
 */
export async function findUserByEmail(email: string): Promise<DirectoryEntry | null> {
  const page = await clerk.users.getUserList({ emailAddress: [email.trim()], limit: 2 });
  const u = page.data[0];
  if (!u) return null;
  // More than one match means the address is attached to two accounts, which
  // Clerk permits for unverified addresses. Refusing is right: silently picking
  // the first would grant cross-tenant read access to whichever account
  // happened to sort first.
  if (page.data.length > 1) throw new Error(`${email} matches more than one account`);
  return {
    clerkUserId: u.id,
    name: displayName(u.firstName, u.lastName),
    email:
      u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress ??
      u.emailAddresses[0]?.emailAddress ??
      email,
    imageUrl: u.imageUrl || null,
    lastActiveAt: u.lastActiveAt ? new Date(u.lastActiveAt).toISOString() : null,
    banned: u.banned,
  };
}

/** Test seam — the cache is module state and would leak between suites. */
export function clearDirectoryCache(): void {
  cache.clear();
}
