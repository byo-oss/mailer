import { checkHeaders } from "./headers";

/**
 * A message to send. The same shape for every provider.
 *
 * `replyTo` is its own field: adapters map it to the provider's reply-to
 * option and never put it in `headers`. `headers` is for extra headers such as
 * `In-Reply-To`, `References` or `List-Unsubscribe`; envelope and
 * provider-owned headers (`From`, `To`, `Subject`, `Reply-To`, `Message-ID`,
 * `Date`, ...) don't belong there.
 */
export type MailMessage = {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
};

/** What a successful `send` returns. */
export type MailResult = {
  /**
   * The provider's id for the send when it reports one (for SES, the SES
   * message id); otherwise an id the adapter makes up (`emailSdkMailer`:
   * `"<adapter>:<uuid>"`, `sesMailer` and `wrapsMailer`: `"ses:<uuid>"`).
   */
  id: string;
  /**
   * The RFC 5322 `Message-ID` actually sent, with angle brackets
   * (`<abc@example.com>`), when the adapter knows it. Many providers replace
   * the header you set (SES always does), so this can differ from anything the
   * caller generated. `wrapsMailer` and `sesMailer` report it for sends
   * through SES in us-east-1; most other adapters can't report it at all.
   * Don't rely on it being present.
   */
  messageId?: string;
};

/**
 * Sends one email. Test an implementation with `testMailer` from
 * `@byo-oss/mailer/testing`.
 *
 * Error semantics, which callers (an outbound queue, a delivery sweep) rely on:
 *
 * - Resolve once the provider has accepted the message.
 * - Throw any error to have the send **retried** later (a timeout, a 5xx,
 *   throttling, bad credentials that an operator may yet fix).
 * - Throw a {@link PermanentMailError} for a send that can never succeed (an
 *   invalid address, a rejected message). Callers fail it at once instead of
 *   retrying.
 * - Don't change the `message` you're given.
 *
 * Sends are at-least-once from the caller's side: a send can repeat after a
 * crash that came after the provider accepted it, so recipients may rarely see
 * a duplicate.
 */
export type Mailer = {
  send(message: MailMessage): Promise<MailResult>;
};

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

export type MemoryMailerOptions = {
  /**
   * Make every `send` throw: `"retry"` throws a plain `Error` (callers retry),
   * `"permanent"` throws a {@link PermanentMailError}. Failed sends aren't
   * recorded. Change it later by assigning to `mailer.fail`.
   */
  fail?: "retry" | "permanent";
  /**
   * Also return a `messageId` (`<mem-1@memory.invalid>`), as a provider that
   * reports the sent `Message-ID` would. Off by default, as most adapters leave it out.
   */
  reportMessageId?: boolean;
};

export type MemoryMailer = Mailer & {
  /** Messages accepted so far, oldest first. A copy: changing it changes nothing. */
  readonly sent: MailMessage[];
  /** Set to make the next sends fail, or `undefined` to succeed again. */
  fail: "retry" | "permanent" | undefined;
  /** Forget the recorded messages. */
  clear(): void;
};

/**
 * A mailer that sends nothing and records what it was given, for tests and
 * local development. Like the adapters, it throws a
 * {@link PermanentMailError} for a malformed header (a name that isn't
 * printable ASCII without `:`, a value with a line break, another control
 * character or non-ASCII text).
 *
 * ```ts
 * const mailer = memoryMailer();
 * await mailer.send({ to: "a@b.test", subject: "Hi", html: "<p>Hi</p>", text: "Hi" });
 * mailer.sent[0]?.subject; // "Hi"
 * ```
 */
export function memoryMailer(options: MemoryMailerOptions = {}): MemoryMailer {
  const store: MailMessage[] = [];
  let counter = 0;

  return {
    fail: options.fail,
    get sent() {
      return structuredClone(store);
    },
    clear() {
      store.length = 0;
    },
    async send(message) {
      // first, as an adapter checks before it calls the provider
      checkHeaders(message.headers);
      if (this.fail === "permanent") {
        throw new PermanentMailError("memoryMailer: permanent failure");
      }
      if (this.fail === "retry") {
        throw new Error("memoryMailer: temporary failure");
      }
      store.push(structuredClone(message));
      counter += 1;
      const id = `mem-${counter}`;
      return options.reportMessageId
        ? { id, messageId: `<${id}@memory.invalid>` }
        : { id };
    },
  };
}
