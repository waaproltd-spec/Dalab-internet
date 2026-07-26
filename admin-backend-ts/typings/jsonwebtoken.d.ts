declare module "jsonwebtoken" {
  export interface SignOptions {
    expiresIn?: number | string;
  }
  function sign(payload: object, secretOrPrivateKey: string, options?: SignOptions): string;
  function verify(token: string, secretOrPublicKey: string): object | string;
  const jwt: { sign: typeof sign; verify: typeof verify };
  export default jwt;
}
