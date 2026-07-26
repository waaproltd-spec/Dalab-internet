/** Same purpose/caveat as node-modules.d.ts — delete once @types/node is installed for real. */
export {};

declare global {
  class Buffer {
    static concat(list: Buffer[]): Buffer;
    static from(data: string, encoding?: string): Buffer;
    toString(encoding?: string): string;
  }

  namespace NodeJS {
    interface ProcessEnv {
      [key: string]: string | undefined;
    }
  }

  const process: {
    env: NodeJS.ProcessEnv;
    exit(code?: number): never;
  };

  const console: {
    log(...args: unknown[]): void;
    error(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };

  function setInterval(callback: () => void, ms: number): unknown;
  function setTimeout(callback: () => void, ms: number): unknown;
  function clearInterval(handle: unknown): void;
  function clearTimeout(handle: unknown): void;

  interface ImportMeta {
    url: string;
  }
}
