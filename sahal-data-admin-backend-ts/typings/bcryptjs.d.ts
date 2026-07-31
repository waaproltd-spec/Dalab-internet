declare module "bcryptjs" {
  function hash(data: string, saltRounds: number): Promise<string>;
  function compare(data: string, encrypted: string): Promise<boolean>;
  const bcrypt: { hash: typeof hash; compare: typeof compare };
  export default bcrypt;
}
