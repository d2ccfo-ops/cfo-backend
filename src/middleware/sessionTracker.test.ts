import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseUserAgent } from "./sessionTracker.js";

// The parse is coarse by design (see the module header), so these tests pin the
// ORDERING traps rather than exhaustive coverage. Every one of them is a case
// where the obvious regex order gives the wrong answer.
describe("parseUserAgent", () => {
  it("does not call every Chromium browser Safari", () => {
    // Chrome's UA ends in "Safari/537.36". Testing /Safari/ first labels the
    // entire Chromium family as Safari.
    const chrome = parseUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );
    expect(chrome.browser).toBe("Chrome");
  });

  it("does not call Edge Chrome", () => {
    // Edge's UA contains "Chrome/131" as well as "Edg/131".
    const edge = parseUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    );
    expect(edge.browser).toBe("Edge");
    expect(edge.os).toBe("Windows");
  });

  it("recognises Chrome on iOS, which never says Chrome", () => {
    // iOS forces every browser onto WebKit, so Chrome there identifies as
    // "CriOS" and carries no "Chrome/" token at all.
    const criOS = parseUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1",
    );
    expect(criOS).toMatchObject({ browser: "Chrome", os: "iOS", deviceKind: "mobile" });
  });

  it("separates real Safari on iPhone from Chrome on iPhone", () => {
    const safari = parseUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    );
    expect(safari).toMatchObject({ browser: "Safari", os: "iOS", deviceKind: "mobile" });
  });

  it("calls an iPad a tablet, not a mobile", () => {
    expect(parseUserAgent("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Safari/604.1").deviceKind).toBe("tablet");
  });

  it("marks scripts and bots as such rather than as desktops", () => {
    expect(parseUserAgent("curl/8.7.1")).toMatchObject({ browser: "script", deviceKind: "script" });
    expect(parseUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)").deviceKind).toBe("bot");
  });

  it("returns nulls rather than guesses for an absent User-Agent", () => {
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null, deviceKind: null });
  });
});

// A private address reaching a third-party geolocation service is both useless
// and a disclosure of internal addressing, so the guard is tested rather than
// trusted. The Docker bridge range (172.16/12) is the one that actually shows
// up here — it is what req.ip returns when `trust proxy` is not set.
describe("isPrivateAddress", () => {
  it("refuses loopback, RFC1918, link-local and IPv6 private ranges", async () => {
    const { isPrivateAddress } = await import("../lib/ipGeo.js");
    for (const ip of ["127.0.0.1", "::1", "10.160.0.2", "172.18.0.5", "172.31.255.255", "192.168.1.9", "169.254.1.1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows real public addresses through", async () => {
    const { isPrivateAddress } = await import("../lib/ipGeo.js");
    for (const ip of ["8.8.8.8", "49.36.180.12", "172.15.0.1", "172.32.0.1", "2404:6800::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

// The address is evidence in a security-facing panel, so where it comes from is
// the part worth a test. Express with `trust proxy` = 1 takes the RIGHTMOST
// X-Forwarded-For entry — the one the proxy appended. A configuration of `true`
// takes the leftmost, which is whatever the client typed.
//
// Driven through a real socket rather than supertest, to avoid adding a
// dependency for two assertions.
describe("trust proxy is a fixed number of hops, not true", () => {
  beforeEach(() => vi.resetModules());

  async function ipSeenBy(trust: number | boolean, header: string): Promise<string> {
    const express = (await import("express")).default;
    const app = express();
    app.set("trust proxy", trust);
    app.get("/", (req, res) => {
      res.json({ ip: req.ip });
    });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { "X-Forwarded-For": header } });
      return ((await res.json()) as { ip: string }).ip;
    } finally {
      server.close();
    }
  }

  it("takes the address the proxy appended, not the one the client claimed", async () => {
    // A caller spoofing a header, behind one real proxy that appended 203.0.113.9.
    const ip = await ipSeenBy(1, "1.2.3.4, 203.0.113.9");
    expect(ip).toBe("203.0.113.9");
    expect(ip).not.toBe("1.2.3.4");
  });

  it("would have believed the spoofed address had it trusted the whole chain", async () => {
    // Deliberately wrong, to pin what the real setting avoids: with `true`,
    // anybody can choose the address they are logged and rate-limited as.
    expect(await ipSeenBy(true, "1.2.3.4, 203.0.113.9")).toBe("1.2.3.4");
  });
});
