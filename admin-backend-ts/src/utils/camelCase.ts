import { Response } from "express";

/** Recursively converts snake_case object keys to camelCase — Postgres
 * returns snake_case column names by default; API responses should be
 * consistently camelCase regardless of which route/table they came from. */
export function toCamelCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamelCase);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      out[camelKey] = toCamelCase(v);
    }
    return out;
  }
  return value;
}

export function sendJson(res: Response, status: number, data: unknown): void {
  res.status(status).json(toCamelCase(data));
}
