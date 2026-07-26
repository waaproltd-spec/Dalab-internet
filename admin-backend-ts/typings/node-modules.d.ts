/**
 * MINIMAL AMBIENT DECLARATIONS — local `tsc --noEmit` checking only, no
 * @types/node available without network access. DELETE this whole
 * `typings/` folder once you `npm install` for real.
 *
 * Deliberately has NO top-level import/export — that's what makes each
 * `declare module "..."` below a genuine new ambient module declaration
 * instead of a "module augmentation" of a module that doesn't exist yet
 * (an earlier version of this file mixed `declare global` into the same
 * file as these, which silently turned every declare module block here
 * into a no-op augmentation — real bug, caught by re-running tsc after
 * splitting them, not by inspection).
 */

declare module "node:crypto" {
  export function randomUUID(): string;
  export function randomBytes(size: number): Buffer;
  export function createHash(algorithm: string): { update(data: string): { digest(encoding: string): string } };
  export function createCipheriv(algorithm: string, key: Buffer, iv: Buffer): {
    update(data: string, inputEncoding: string): Buffer;
    final(): Buffer;
    getAuthTag(): Buffer;
  };
  export function createDecipheriv(algorithm: string, key: Buffer, iv: Buffer): {
    setAuthTag(tag: Buffer): void;
    update(data: Buffer): Buffer;
    final(): Buffer;
  };
  export function scryptSync(password: string, salt: string, keylen: number): Buffer;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}

declare module "node:path" {
  const path: {
    dirname(p: string): string;
    join(...parts: string[]): string;
  };
  export default path;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
