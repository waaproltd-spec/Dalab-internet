import { queryOne } from "../db/pool.js";

export type PaymentRoleCheck = "send" | "receive";

/**
 * Whether the given agent's assigned device (agent_devices.payment_role,
 * see 048_agent_device_payment_role.sql — Admin > Mobile Management) is
 * allowed to perform `check` ("send" = dial USSD, "receive" = act on
 * incoming payment SMS). An agent with no device assigned yet is
 * unrestricted — same as every agent's behavior before this column
 * existed, and the same "empty = unrestricted" convention already used
 * for agent_company_assignments.
 */
export async function agentDeviceAllows(agentId: string, check: PaymentRoleCheck): Promise<boolean> {
  const agent = await queryOne<{ device_id: string | null }>(`SELECT device_id FROM agents WHERE id=$1`, [agentId]);
  if (!agent?.device_id) return true;
  const device = await queryOne<{ payment_role: string }>(`SELECT payment_role FROM agent_devices WHERE id=$1`, [agent.device_id]);
  if (!device) return true;
  if (check === "send") return device.payment_role !== "receive_only";
  return device.payment_role !== "send_only";
}
