import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Applies 001_init.sql against DATABASE_URL. Every statement uses
 * CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, so this is safe
 * to run on every deploy (Render's build step calls `npm run migrate`
 * automatically — see render.yaml) without a migration-tracking table; for
 * a schema change beyond this initial version, add 002_*.sql and extend the
 * `files` array below rather than editing 001 in place.
 */
async function migrate() {
  const files = [
    "001_init.sql",
    "002_admin_controls.sql",
    "003_realtime_and_automation.sql",
    "004_device_health_and_failover.sql",
    "005_idempotency_and_dedup.sql",
    "006_promo_images.sql",
    "007_ussd_template_device_assignment.sql",
    "008_activity_log_and_package_code.sql",
    "009_dial_attempt_completed_at.sql",
    "010_payment_wallets.sql",
    "011_payment_dedup_hardening.sql",
    "012_cleanup_hardcoded_ussd_pin.sql",
    "013_package_provider_amount.sql",
    "014_payment_transactions_ledger.sql",
    "015_customer_pin.sql",
    "016_mask_ussd_pin.sql",
    "017_read_pagination_indexes.sql",
    "018_payment_tx_filters_indexes.sql",
    "019_payment_wallets_company_id.sql",
    "020_company_details.sql",
    "021_company_soft_delete.sql",
    "022_ussd_generation_failure_reason.sql",
    "023_package_ussd_template_link.sql",
    "024_provider_number.sql",
    "025_schedule_recharge.sql",
    "026_commission_management.sql",
    "027_agent_diagnostics_log.sql",
  ];
  for (const file of files) {
    const sql = readFileSync(path.join(__dirname, "migrations", file), "utf8");
    // eslint-disable-next-line no-console
    console.log(`Applying migration: ${file}`);
    await pool.query(sql);
  }
  // eslint-disable-next-line no-console
  console.log("Migrations complete.");
  await pool.end();
}

migrate().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Migration failed:", err);
  process.exit(1);
});
