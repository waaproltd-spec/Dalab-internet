export type Role = "super_admin" | "admin" | "agent" | "customer";

export interface JwtPayload {
  sub: string;
  role: Role;
  type?: "refresh";
  jti?: string;
  iat?: number;
  exp?: number;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export type OrderStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
export type CompanyStatus = "online" | "offline";
export type AgentStatus = "active" | "suspended";
export type CustomerStatus = "active" | "blocked";
