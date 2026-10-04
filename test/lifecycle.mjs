import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../lib/index.js";
import { acquireUsageStore, usageFilePath } from "../lib/storage.js";
import { createCtx } from "./harness.mjs";

function setup(t) {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-lifecycle-"));
  process.env.DSH_HOME = home;
  const harness = createCtx({ schema: Config });
  const effects = [];
  harness.ctx.effect = (setup) => { const release = setup(); effects.push(release); return release; };
  harness.ctx.webServer.register = (route) => {
    if (harness.routes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
    harness.routes.set(route.path, route.handler);
    return () => harness.routes.delete(route.path);
  };
  const unload = () => { for (const release of effects.splice(0)) release(); };
  t.after(() => {
    unload();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  return { ...harness, home, unload };
}

test("constructor activation releases routes on host unload and stale disposers preserve new activation", async (t) => {
  const harness = setup(t);
  const old = new apply(harness.ctx, harness.configRef);
  assert.equal((await harness.call("/api/dsh-token-quota/state")).ok, true);
  harness.unload();
  assert.equal(harness.routes.size, 0);
  assert.equal(harness.events.size, 0);
  new apply(harness.ctx, harness.configRef);
  old();
  assert.equal((await harness.call("/api/dsh-token-quota/state")).ok, true);
});

test("partial route failure releases owned resources and preserves the conflicting route", async (t) => {
  const harness = setup(t);
  const owner = () => {};
  harness.routes.set("/api/dsh-token-quota/refresh", owner);
  assert.throws(() => new apply(harness.ctx, harness.configRef), /duplicate exact route/);
  assert.equal(harness.routes.size, 1);
  assert.equal(harness.routes.get("/api/dsh-token-quota/refresh"), owner);
  assert.equal(harness.events.size, 0);
  harness.unload();
  harness.routes.delete("/api/dsh-token-quota/refresh");
  new apply(harness.ctx, harness.configRef);
  assert.equal((await harness.call("/api/dsh-token-quota/state")).ok, true);
});

test("a failing event disposer does not prevent route and usage-store release", (t) => {
  const harness = setup(t);
  const lease = acquireUsageStore(usageFilePath(harness.home));
  t.after(() => lease.release());
  const originalOn = harness.ctx.on;
  harness.ctx.on = (name, fn) => {
    const release = originalOn(name, fn);
    return () => { release(); throw new Error("event cleanup failure"); };
  };
  new apply(harness.ctx, harness.configRef);
  harness.unload();
  assert.equal(harness.routes.size, 0);
  assert.equal(harness.events.size, 0);
  assert.equal(lease.store.clients.size, 1);
});

test("initialization failure before save-timer setup releases the usage-store lease", (t) => {
  const harness = setup(t);
  const lease = acquireUsageStore(usageFilePath(harness.home));
  t.after(() => lease.release());
  harness.ctx.on = () => { throw new Error("event registration failure"); };
  assert.throws(() => new apply(harness.ctx, harness.configRef), /event registration failure/);
  harness.unload();
  assert.equal(lease.store.clients.size, 1);
});
