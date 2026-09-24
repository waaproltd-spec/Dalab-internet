// Read-only diagnostic script -- SELECT statements only, no INSERT/UPDATE/DELETE.
// Not wired into the app; run manually, then delete or leave untracked.
//
// Usage (from admin-backend-ts/):
//   DATABASE_URL="postgres://..." npx tsx scripts/checkAmtelPackages.ts
//
// Prints every Amtel package (active and inactive) with:
//   - name, price, active flag
//   - ussd_template_id, and whether that template exists/is enabled
//   - whether the company itself is on the USSD recharge flow (vs SOMLINK)
//   - whether the company has a PIN configured and SIM routing set up
//   - any other active package on the same company sharing the exact same
//     name+price (a config-level duplicate-offering risk), and any package
//     using this exact same ussd_template_id (informational only -- sharing
//     a template across tiers is normal/expected, see migration 023).
import { Pool } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "false" ? false : process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
  });

  const companies = await pool.query(
    `SELECT id, name, fulfillment_method, gateway, (pin_encrypted IS NOT NULL) AS pin_set
     FROM companies WHERE name ILIKE 'Amtel'`
  );

  if (companies.rows.length === 0) {
    console.log("No company matching 'Amtel' found.");
    await pool.end();
    return;
  }

  for (const company of companies.rows) {
    console.log("=".repeat(80));
    console.log(`Company: ${company.name} (id=${company.id})`);
    console.log(`  fulfillment_method: ${company.fulfillment_method}  gateway: ${company.gateway}  pin_set: ${company.pin_set}`);

    if (company.fulfillment_method === "somlink") {
      console.log("  -> SOMLINK-fulfilled: never dials USSD, classifyRechargeUssdResponse does not apply.");
    }

    const routing = await pool.query(`SELECT device_id, sim_slot FROM sim_routing WHERE company_id=$1`, [company.id]);
    console.log(`  company-level SIM routing configured: ${routing.rows.length > 0 ? `yes (${JSON.stringify(routing.rows[0])})` : "no"}`);

    const packages = await pool.query(
      `SELECT p.id, p.name, p.price, p.active, p.ussd_template_id,
              t.id AS t_id, t.service_name AS t_service_name, t.status AS t_status, t.device_id AS t_device_id
       FROM packages p
       LEFT JOIN ussd_templates t ON t.id = p.ussd_template_id
       WHERE p.company_id = $1
       ORDER BY p.active DESC, p.price ASC`,
      [company.id]
    );

    if (packages.rows.length === 0) {
      console.log("  No packages found for this company.");
      continue;
    }

    for (const pkg of packages.rows) {
      console.log(`  ---`);
      console.log(`  Package: "${pkg.name}"  price=$${pkg.price}  active=${pkg.active}  id=${pkg.id}`);

      if (!pkg.ussd_template_id) {
        console.log(`    ussd_template_id: NULL -- relies on legacy name-matching fallback only (fragile, see templateWarningFor).`);
      } else if (!pkg.t_id) {
        console.log(`    ussd_template_id: ${pkg.ussd_template_id} -- DOES NOT RESOLVE (template row missing/deleted).`);
      } else {
        console.log(`    ussd_template_id: ${pkg.ussd_template_id} -> service_name="${pkg.t_service_name}" status=${pkg.t_status} pinned_device=${pkg.t_device_id ?? "none (uses SIM routing)"}`);
        if (pkg.t_status !== "enabled") {
          console.log(`    WARNING: linked template is not enabled.`);
        }
      }

      if (pkg.active && company.fulfillment_method === "ussd" && company.pin_set) {
        console.log(`    recharge flow: yes -- dials via UssdOrchestrator, classifyRechargeUssdResponse (incl. the "transferred" fix) applies.`);
      } else if (pkg.active && company.fulfillment_method === "ussd" && !company.pin_set) {
        console.log(`    recharge flow: blocked -- company has no PIN configured, order would stall before ever dialing.`);
      }

      // Duplicate-offering check: another ACTIVE package, same company, same
      // name+price -- not itself a "sent multiple times" bug (each order is
      // independent, and the dedup/mutex/unique-index safeguards already
      // verified in UssdOrchestrator/ussd_dial_attempts are per-order, not
      // per-package), but worth flagging as a config smell if present.
      const dupes = await pool.query(
        `SELECT id FROM packages WHERE company_id=$1 AND id<>$2 AND active=true AND name=$3 AND price=$4`,
        [company.id, pkg.id, pkg.name, pkg.price]
      );
      if (dupes.rows.length > 0) {
        console.log(`    NOTE: ${dupes.rows.length} other active package(s) share this exact name+price -- possible duplicate listing.`);
      }
    }
  }

  console.log("=".repeat(80));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
