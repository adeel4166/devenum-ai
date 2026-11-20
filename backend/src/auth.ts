import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { UserRole } from "@prisma/client";
import { prisma } from "./db";

export interface AuthUser { id: number; email: string; role: UserRole; name: string }
declare module "express-serve-static-core" {
  interface Request { user?: AuthUser }
}

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return s;
};

export const signToken = (u: AuthUser) =>
  jwt.sign(u, secret(), { expiresIn: (process.env.JWT_EXPIRES_IN || "12h") as jwt.SignOptions["expiresIn"] });

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing token" });
  try {
    const p = jwt.verify(h.slice(7), secret()) as AuthUser;
    // Re-check the database so deactivated users / role changes take effect immediately.
    const u = await prisma.user.findUnique({ where: { id: p.id } });
    if (!u || !u.isActive) return res.status(401).json({ error: "Account disabled" });
    req.user = { id: u.id, email: u.email, role: u.role, name: u.name };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export const requireRole = (...roles: UserRole[]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden for your role" });
  next();
};
