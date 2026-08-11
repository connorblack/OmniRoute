import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.resolve(
  here,
  "../../src/app/(dashboard)/dashboard/tools/agent-bridge/page.tsx"
);

test("Agent Bridge dashboard page is rendered dynamically", () => {
  const source = fs.readFileSync(pagePath, "utf8");

  assert.match(
    source,
    /export const dynamic = "force-dynamic";/,
    "the page reads live provider and MITM state and must not be statically generated"
  );
  assert.match(
    source,
    /cache:\s*"no-store"/,
    "the page's Agent Bridge state fetch must remain uncached"
  );
});
