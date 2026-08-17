import { randomUUID } from "node:crypto";
import { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";

export type ResellerWalletReferenceType =
  | "order"
  | "exchange"
  | "deposit"
  | "withdrawal_reservation"
  | "withdrawal_release"
  | "withdrawal"
  | "admin_adjustment";

export type ResellerWalletSource = "sms" | "admin_manual" | "system";

/**
 * The single call site every reseller-balance-changing path must go
 * through — locks the wallet row, applies the delta, and writes the
 * before/after audit row atomically, mirroring how creditCommissionIfNeeded
 * is the one place commission balances change (src/utils/commissions.ts).
 * `changeAmount` is signed: positive credits, negative debits. Throws if the
 * resulting balance would go negative, since every debit path (order
 * payment, withdrawal reservation) must never let a reseller overdraw.
 */
export async function adjustResellerWallet(params: {
  resellerId: string;
  changeAmount: number;
  referenceType: ResellerWalletReferenceType;
  referenceId?: string | null;
  source: ResellerWalletSource;
  changedByAdminId?: string | null;
  client?: PoolClient;
}): Promise<{ previousBalance: number; newBalance: number }> {
  const run = async (client: PoolClient) => {
    const walletResult = await client.query(
      `SELECT balance FROM reseller_wallets WHERE reseller_id=$1 FOR UPDATE`,
      [params.resellerId]
    );
    if (walletResult.rows.length === 0) {
      throw new Error(`No wallet row for reseller ${params.resellerId}`);
    }
    const previousBalance = Number(walletResult.rows[0].balance);
    const newBalance = Math.round((previousBalance + params.changeAmount) * 100) / 100;
    if (newBalance < 0) {
      throw new Error("Insufficient wallet balance");
    }

    await client.query(`UPDATE reseller_wallets SET balance=$1, updated_at=now() WHERE reseller_id=$2`, [
      newBalance,
      params.resellerId,
    ]);
    await client.query(
      `INSERT INTO reseller_wallet_transactions
         (id, reseller_id, previous_balance, new_balance, change_amount, reference_type, reference_id, source, changed_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        params.resellerId,
        previousBalance,
        newBalance,
        params.changeAmount,
        params.referenceType,
        params.referenceId ?? null,
        params.source,
        params.changedByAdminId ?? null,
      ]
    );
    return { previousBalance, newBalance };
  };

  if (params.client) return run(params.client);
  return withTransaction(run);
}
