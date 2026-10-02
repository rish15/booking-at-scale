// Replaces the Sequelize-era config/config.json. No ORM, no per-environment
// dialect/host/user blocks — just the env vars the app actually reads,
// validated once at boot so a missing value fails fast instead of surfacing
// as a confusing error mid-request.

import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Env var ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

export const config = {
  env: process.env.NODE_ENV || "local",
  port: int("PORT", 2000),

  databaseUrl: required("DATABASE_URL"),

  authTokenSecret: required("AUTH_TOKEN_SECRET"),
  adminKey: required("ADMIN_KEY"),

  perUserLimit: int("PER_USER_LIMIT", 4),
  holdExpirySeconds: int("HOLD_EXPIRY_SECONDS", 60),

  db: {
    statementTimeoutMs: int("DB_STATEMENT_TIMEOUT_MS", 5000),
    lockTimeoutMs: int("DB_LOCK_TIMEOUT_MS", 3000),
    poolMax: int("DB_POOL_MAX", 15),
  },
};
