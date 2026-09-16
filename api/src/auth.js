import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "deskly-local-dev-secret";

export function signToken(userId, username) {
  return jwt.sign({ sub: userId, username }, JWT_SECRET, { expiresIn: "30d" });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export async function requireAuth(request, reply) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return reply.code(401).send({ error: "Please log in." });
  }
  try {
    request.user = verifyToken(token);
  } catch {
    return reply.code(401).send({ error: "Session expired. Log in again." });
  }
}
