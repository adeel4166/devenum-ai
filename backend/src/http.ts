import { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";

export const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) return res.status(400).json({ error: "Validation failed", issues: err.issues });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(JSON.stringify({ level: "error", message: String((err as Error)?.message ?? err) }));
  res.status(500).json({ error: "Internal server error" });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const idParam = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Invalid id");
  return n;
};
