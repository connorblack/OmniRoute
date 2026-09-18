import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-pii-identifiers-"));
process.env.DATA_DIR = tmpDir;

test("sanitizePII leaves SQL identifiers alone and still redacts real keys and phones", async (t) => {
  const { setFeatureFlagOverride } = await import("@/lib/db/featureFlags");
  setFeatureFlagOverride("PII_RESPONSE_SANITIZATION", "true");
  const { sanitizePII } = await import("@/lib/piiSanitizer");

  await t.test("bracketed and bare PK_ constraint names are not API keys", () => {
    for (const text of [
      "CONSTRAINT [PK_EnrollmentStatusCodeHistory] PRIMARY KEY CLUSTERED",
      "CONSTRAINT PK_FileImportDataCommonFormat_old PRIMARY KEY",
      "ALTER TABLE t ADD CONSTRAINT [API_KeyRotationHistoryPrimary] UNIQUE",
    ]) {
      assert.equal(sanitizePII(text).text, text);
    }
  });

  await t.test("digit runs inside identifiers are not phone numbers", () => {
    const text = "INDEX [_dta_index_Employees_21_1234567890__K2_K6] ON dbo.Employees";
    assert.equal(sanitizePII(text).text, text);
  });

  await t.test("lowercase vendor keys are still redacted", () => {
    assert.equal(sanitizePII("token sk_abcdefghijklmnopqrstuvwxyz1234").text, "token [API_KEY_REDACTED]");
    assert.equal(sanitizePII("key: pk-abcdefghijklmnopqrstuvwxyz1234").text, "key: [API_KEY_REDACTED]");
  });

  await t.test("phone numbers in prose are still redacted", () => {
    assert.equal(sanitizePII("call (555) 123-4567 today").text, "call [PHONE_REDACTED] today");
    assert.equal(sanitizePII("ligue (11) 91234-5678").text, "ligue [PHONE_REDACTED]");
  });
});
