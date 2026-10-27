type PgError = {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: unknown;
};

function unwrap(error: unknown): PgError | null {
  if (!error || typeof error !== "object") return null;
  const direct = error as PgError;
  const cause = direct.cause;
  if (cause && typeof cause === "object") {
    const nested = cause as PgError;
    return {
      code: direct.code ?? nested.code,
      constraint: direct.constraint ?? nested.constraint,
      message: direct.message ?? nested.message,
    };
  }
  return direct;
}

/**
 * Postgres unique-violation (23505) detection that works through the
 * neon-http driver, which can wrap driver errors in `cause`.
 */
export function isUniqueViolation(error: unknown, constraint?: string) {
  const err = unwrap(error);
  if (!err || String(err.code ?? "") !== "23505") return false;
  if (!constraint) return true;

  const name = String(err.constraint ?? "");
  if (name === constraint) return true;
  return String(err.message ?? "").includes(constraint);
}
