import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtPayload {
  uid: number;
  role: "admin" | "user";
  exp: number;
}

export function signJwt(payload: { uid: number; role: "admin" | "user" }, secret: string, ttlSeconds: number): string {
  const body: JwtPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${head}.${claims}`).digest("base64url");
  return `${head}.${claims}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, claims, sig] = parts;
  const expected = createHmac("sha256", secret).update(`${head}.${claims}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as JwtPayload;
    if (typeof payload.uid !== "number" || (payload.role !== "admin" && payload.role !== "user")) return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
