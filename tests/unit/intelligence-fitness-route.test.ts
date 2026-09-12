/**
 * Route tests for /api/intelligence/fitness — the management surface for the
 * `user_override` layer of the auto-combo task-fitness resolution chain
 * (open-sse/services/autoCombo/taskFitness.ts). Exercises PUT/GET/DELETE end to
 * end against the route handlers, including cache invalidation (no restart
 * between write and read) and category/score validation.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { getTaskFitnessWithSource } from "../../open-sse/services/autoCombo/taskFitness.ts";
import * as fitnessRoute from "../../src/app/api/intelligence/fitness/route.ts";

const BASE = "http://localhost/api/intelligence/fitness";

function putRequest(body: unknown): Request {
  return new Request(BASE, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(query = ""): Request {
  return new Request(`${BASE}${query}`);
}

function deleteRequest(query: string): Request {
  return new Request(`${BASE}${query}`, { method: "DELETE" });
}

async function json(res: Response): Promise<any> {
  return res.json();
}

describe("/api/intelligence/fitness", () => {
  after(() => {
    resetDbInstance();
  });

  it("PUT writes an override and GET lists it", async () => {
    const model = "test-vendor/fitness-route-list-9001";
    const res = await fitnessRoute.PUT(putRequest({
      overrides: [{ model, category: "coding", score: 0.83 }],
    }));
    assert.equal(res.status, 200);
    const putBody = await json(res);
    assert.deepEqual(putBody.written, [{ model, category: "coding", score: 0.83 }]);

    const listRes = await fitnessRoute.GET(getRequest());
    assert.equal(listRes.status, 200);
    const listBody = await json(listRes);
    const entry = listBody.overrides.find((o: any) => o.model === model);
    assert.ok(entry, "written override must appear in the unfiltered list");
    assert.equal(entry.category, "coding");
    assert.equal(entry.score, 0.83);
  });

  it("PUT then resolved GET reports source user_override with the written score", async () => {
    const model = "test-vendor/fitness-route-resolve-9002";
    await fitnessRoute.PUT(putRequest({
      overrides: [{ model, category: "analysis", score: 0.91 }],
    }));

    const res = await fitnessRoute.GET(
      getRequest(`?models=${encodeURIComponent(model)}&taskTypes=analysis`)
    );
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual(body.resolved, [
      { model, taskType: "analysis", score: 0.91, source: "user_override" },
    ]);
  });

  it("DELETE clears an override and resolution falls back to a lower layer", async () => {
    const model = "test-vendor/fitness-route-delete-9003";
    await fitnessRoute.PUT(putRequest({
      overrides: [{ model, category: "debugging", score: 0.77 }],
    }));

    const before = getTaskFitnessWithSource(model, "debugging");
    assert.equal(before.source, "user_override");
    assert.equal(before.score, 0.77);

    const delRes = await fitnessRoute.DELETE(
      deleteRequest(`?model=${encodeURIComponent(model)}&category=debugging`)
    );
    assert.equal(delRes.status, 200);
    const delBody = await json(delRes);
    assert.equal(delBody.existed, true);

    const after1 = getTaskFitnessWithSource(model, "debugging");
    assert.notEqual(after1.source, "user_override");
    assert.equal(after1.score, 0.5, "unknown model falls back to the neutral wildcard baseline");

    const delAgain = await fitnessRoute.DELETE(
      deleteRequest(`?model=${encodeURIComponent(model)}&category=debugging`)
    );
    const delAgainBody = await json(delAgain);
    assert.equal(delAgainBody.existed, false, "a second delete of the same override reports false");
  });

  it("cache invalidation: a resolve immediately after PUT reflects the new score, no restart", async () => {
    const model = "test-vendor/fitness-route-cache-9004";

    // Prime the resolution cache with the pre-override (wildcard) score.
    const primed = getTaskFitnessWithSource(model, "planning");
    assert.equal(primed.score, 0.5);
    assert.notEqual(primed.source, "user_override");

    await fitnessRoute.PUT(putRequest({
      overrides: [{ model, category: "planning", score: 0.66 }],
    }));

    const res = await fitnessRoute.GET(
      getRequest(`?models=${encodeURIComponent(model)}&taskTypes=planning`)
    );
    const body = await json(res);
    assert.deepEqual(body.resolved, [
      { model, taskType: "planning", score: 0.66, source: "user_override" },
    ]);
  });

  it("PUT rejects a score outside [0,1]", async () => {
    const res = await fitnessRoute.PUT(putRequest({
      overrides: [{ model: "test-vendor/bad-score", category: "coding", score: 1.5 }],
    }));
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.ok(body.error);
  });

  it("PUT rejects an unknown category and lists valid ones", async () => {
    const res = await fitnessRoute.PUT(putRequest({
      overrides: [{ model: "test-vendor/bad-category", category: "not-a-real-category", score: 0.5 }],
    }));
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.match(body.error.message, /Unknown task category/);
    assert.match(body.error.message, /coding/);
  });

  it("GET resolve rejects an unknown taskType", async () => {
    const res = await fitnessRoute.GET(
      getRequest("?models=some-model&taskTypes=not-a-real-category")
    );
    assert.equal(res.status, 400);
  });

  it("DELETE requires both model and category", async () => {
    const res = await fitnessRoute.DELETE(deleteRequest("?model=only-model"));
    assert.equal(res.status, 400);
  });
});
