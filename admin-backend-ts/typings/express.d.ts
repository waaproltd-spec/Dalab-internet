declare module "express" {
  export interface Request {
    body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    params: Record<string, string>;
    query: Record<string, string | string[] | undefined>;
    headers: Record<string, string | undefined>;
    socket: { remoteAddress?: string };
    /** Set by requireAuth() (src/auth/middleware.ts) after verifying the bearer token. */
    auth?: { sub: string; role: string; type?: string; jti?: string; iat?: number; exp?: number };
  }
  export interface Response {
    status(code: number): Response;
    json(body: unknown): Response;
    send(body?: unknown): Response;
    end(body?: string): Response;
    setHeader(name: string, value: string): void;
  }
  export type NextFunction = (err?: unknown) => void;
  export type RequestHandler = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;
  export type ErrorRequestHandler = (err: Error, req: Request, res: Response, next: NextFunction) => void;

  export interface Router {
    get(path: string, ...handlers: RequestHandler[]): Router;
    post(path: string, ...handlers: RequestHandler[]): Router;
    put(path: string, ...handlers: RequestHandler[]): Router;
    delete(path: string, ...handlers: RequestHandler[]): Router;
  }
  export function Router(): Router;

  export interface Express {
    use(...args: unknown[]): Express;
    get(path: string, ...handlers: RequestHandler[]): Express;
    listen(port: number, callback: () => void): void;
  }
  function express(): Express;
  namespace express {
    function json(): RequestHandler;
  }
  export default express;
}
