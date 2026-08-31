// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Proves generateUssdForOrder actually applies
// normalizePhoneForUssd/formatUssdAmount end-to-end -- not just that the pure
// formatter functions are correct in isolation, but that the one function
// building every Internet Store dial string (all five providers) actually
// calls them, for both an ID-linked package and a name-fallback-matched one,
// and that the amount/PIN masking on the returned maskedUssd matches.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, queryOne, pool } from "../../db/pool.js";
import { encrypt } from "../../auth/crypto.js";
import { generateUssdForOrder } from "../ussd.routes.js";

const COMPANY_ID = "test-generate-ussd-co";
const CATEGORY_ID = randomUUID();
const CUSTOMER_ID = randomUUID();

before(async () => {
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);

  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, pin_encrypted) VALUES ($1,'Test Telco',1,'#000000',$2)`,
    [COMPANY_ID, encrypt("8233")]
  );
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_ID]);
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '252699000099')`, [CUSTOMER_ID]);
});

after(async () => {
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await pool.end();
});

beforeEach(async () => {
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
});

async function makeTemplate(serviceName: string, ussdCode: string) {
  const id = randomUUID();
  await query(
    `INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, status) VALUES ($1,$2,$3,$4,'enabled')`,
    [id, COMPANY_ID, serviceName, ussdCode]
  );
  return id;
}

async function makePackage(name: string, providerAmount: number, ussdTemplateId: string | null) {
  const id = randomUUID();
  await query(
    `INSERT INTO packages (id, company_id, category_id, name, price, provider_amount, ussd_template_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, COMPANY_ID, CATEGORY_ID, name, providerAmount, providerAmount, ussdTemplateId]
  );
  return id;
}

async function makeOrder(packageId: string, receiverPhone: string, providerAmount: number) {
  const id = "TEST" + Math.floor(Math.random() * 1_000_000_000);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, provider_amount, status, receiver_phone, channel)
     VALUES ($1,$2,$3,$4,$5,$6,'in_progress',$7,'customer_app')`,
    [id, CUSTOMER_ID, COMPANY_ID, packageId, providerAmount, providerAmount, receiverPhone]
  );
  return await queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [id]);
}

test("ID-linked package: 252-prefixed number is stripped and a round-tens cents amount drops its trailing zero (0.10 -> 0*1)", async () => {
  const templateId = await makeTemplate("Anfac", "*737*{number}*{amount}*{pin}#");
  const packageId = await makePackage("Anfac Kuhadal", 0.10, templateId);
  const order = await makeOrder(packageId, "252619991299", 0.10);

  const result = await generateUssdForOrder(order);
  assert.equal(result.error, undefined);
  assert.equal(result.ussd, "*737*619991299*0*1*8233#");
  assert.equal(result.maskedUssd, "*737*619991299*0*1*••••#");
});

test("ID-linked package: a whole-dollar amount omits the cents segment entirely (25.00 -> 25, never 25*0)", async () => {
  const templateId = await makeTemplate("5G Plus", "*727*{number}*{amount}*{pin}#");
  const packageId = await makePackage("5g plus", 25.00, templateId);
  const order = await makeOrder(packageId, "0685115555", 25.00);

  const result = await generateUssdForOrder(order);
  assert.equal(result.ussd, "*727*685115555*25*8233#");
  assert.ok(!result.ussd!.includes("*0*"), `unexpected trailing zero segment: ${result.ussd}`);
});

test("ID-linked package: a non-round cents value keeps both digits (4.25 -> 4*25)", async () => {
  const templateId = await makeTemplate("Qanciye Plus", "*830*{number}*{amount}*{pin}#");
  const packageId = await makePackage("Qanciye Plus 1.2GB", 4.25, templateId);
  const order = await makeOrder(packageId, "685115555", 4.25);

  const result = await generateUssdForOrder(order);
  assert.equal(result.ussd, "*830*685115555*4*25*8233#");
});

test("name-fallback package (no ussd_template_id): the same normalization still applies", async () => {
  const templateId = await makeTemplate("Bulaal Unlimited Data", "*918*{number}*{amount}*{pin}#");
  const packageId = await makePackage("Bulaal Unlimited Data", 17.50, null);
  const order = await makeOrder(packageId, "+252 68-511-5555", 17.50);

  const result = await generateUssdForOrder(order);
  assert.equal(templateId != null, true);
  assert.equal(result.ussd, "*918*685115555*17*5*8233#");
});

test("the PIN stays the final parameter before '#' regardless of amount segment count", async () => {
  const templateId = await makeTemplate("No Expire", "*830*{number}*{amount}*{pin}#");
  const packageId = await makePackage("No Expire Bundle", 1.00, templateId);
  const order = await makeOrder(packageId, "685115555", 1.00);

  const result = await generateUssdForOrder(order);
  assert.ok(result.ussd!.endsWith("*8233#"), result.ussd);
});
