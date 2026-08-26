// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/matchTemplateByName.test.ts
//
// Covers matchTemplateByName's substring fallback -- specifically the fix
// for its previous unordered Array.find() over a query with no ORDER BY,
// which could silently pick the wrong template whenever a package's name
// matched more than one template as a substring (e.g. "Anfac" and
// "Anfac Plus" both matching a package named "Anfac Plus 5GB").
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, pool } from "../../db/pool.js";
import { matchTemplateByName } from "../ussd.routes.js";

const COMPANY_ID = "test-match-template-co";

before(async () => {
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Test Co',1,'#000000')`, [COMPANY_ID]);
});

after(async () => {
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await pool.end();
});

beforeEach(async () => {
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
});

async function makeTemplate(serviceName: string, status: "enabled" | "disabled" = "enabled") {
  const id = randomUUID();
  await query(
    `INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, status) VALUES ($1,$2,$3,$4,$5)`,
    [id, COMPANY_ID, serviceName, "*123*{number}*{amount}*{pin}#", status]
  );
  return id;
}

test("exact (case-insensitive) name match wins outright", async () => {
  const id = await makeTemplate("Anfac Plus");
  const match = await matchTemplateByName(COMPANY_ID, "anfac plus");
  assert.equal(match?.id, id);
});

test("a single substring match resolves normally", async () => {
  const id = await makeTemplate("Anfac");
  const match = await matchTemplateByName(COMPANY_ID, "Anfac Kuhadal");
  assert.equal(match?.id, id);
});

test("the most specific (longest) matching template name wins over a shorter substring", async () => {
  await makeTemplate("Anfac");
  const plusId = await makeTemplate("Anfac Plus");
  // Contains both "Anfac" and "Anfac Plus" as substrings -- must resolve to
  // the more specific one, not whichever the DB happens to return first.
  const match = await matchTemplateByName(COMPANY_ID, "Anfac Plus 5GB");
  assert.equal(match?.id, plusId);
});

test("a genuine tie between two equally-specific, differently-named templates is treated as no match", async () => {
  await makeTemplate("Kaafi Voice");
  await makeTemplate("Voice Kaafi"); // same length as above, different name, both substrings of the package name below
  const match = await matchTemplateByName(COMPANY_ID, "Kaafi Voice Kaafi Bundle");
  assert.equal(match, null);
});

test("no candidate at all returns null", async () => {
  await makeTemplate("Unrelated Bundle");
  const match = await matchTemplateByName(COMPANY_ID, "Totally Different Package");
  assert.equal(match, null);
});

test("a disabled template is never matched, even as an exact name match", async () => {
  await makeTemplate("Anfac", "disabled");
  const match = await matchTemplateByName(COMPANY_ID, "Anfac");
  assert.equal(match, null);
});

test("matching is scoped to the given company -- another company's identically-named template never matches", async () => {
  const otherCompanyId = "test-match-template-other-co";
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [otherCompanyId]);
  await query(`DELETE FROM companies WHERE id=$1`, [otherCompanyId]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Other Co',1,'#111111')`, [otherCompanyId]);
  await query(
    `INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, status) VALUES ($1,$2,'Anfac','*123*{number}*{amount}*{pin}#','enabled')`,
    [randomUUID(), otherCompanyId]
  );
  const match = await matchTemplateByName(COMPANY_ID, "Anfac");
  assert.equal(match, null);
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [otherCompanyId]);
  await query(`DELETE FROM companies WHERE id=$1`, [otherCompanyId]);
});
