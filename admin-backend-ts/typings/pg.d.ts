declare module "pg" {
  export interface PoolConfig {
    connectionString?: string;
    ssl?: boolean | { rejectUnauthorized: boolean };
    max?: number;
    connectionTimeoutMillis?: number;
    statement_timeout?: number;
    query_timeout?: number;
  }
  export interface QueryResult<T = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    rows: T[];
  }
  export class Pool {
    constructor(config: PoolConfig);
    query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    connect(): Promise<PoolClient>;
    on(event: "error", listener: (err: Error) => void): void;
    end(): Promise<void>;
  }
  export interface PoolClient {
    query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    release(err?: Error): void;
  }
}
