const PERMANENT = Symbol.for("@byo-oss/mailer/permanent");

/**
 * Throw from `Mailer.send` for a send that will never succeed, such as an
 * invalid recipient address or a message the provider rejected as malformed.
 * The caller marks the delivery failed without retrying. Any other error
 * means retry.
 *
 * Check for it with {@link isPermanentMailError}, not `instanceof`, so it is
 * recognised when two copies of this package are installed.
 */
export class PermanentMailError extends Error {
  readonly permanent = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentMailError";
    Object.defineProperty(this, PERMANENT, { value: true });
  }
}

/**
 * True for a {@link PermanentMailError}, including one created by another
 * copy of this package (matched by a shared `Symbol.for` brand, not by class).
 */
export function isPermanentMailError(error: unknown): error is Error {
  return (
    error instanceof PermanentMailError ||
    (typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[PERMANENT] === true)
  );
}
