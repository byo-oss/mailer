import type { WrapsEmailConfig } from "@wraps.dev/email";
import {
  type Mailer,
  type MailMessage,
  type MailResult,
  PermanentMailError,
} from "./index";

/** The part of `WrapsEmail` this adapter uses, so tests can pass a fake. */
export type WrapsMailerClient = {
  send: (params: {
    from: string;
    to: string | string[];
    subject: string;
    html: string;
    text: string;
    replyTo?: string;
    headers?: Record<string, string>;
  }) => Promise<{ messageId: string }>;
};

export type WrapsMailerOptions = Omit<Partial<WrapsEmailConfig>, "client"> & {
  /** Sender address, verified in your SES account: `"Acme <help@acme.com>"`. */
  from: string;
  /**
   * A configured `new WrapsEmail({ ... })`. Without it, one is created on the
   * first send from the other options here (region, credentials, ...), which
   * resolve AWS credentials from the environment when not given.
   */
  client?: WrapsMailerClient;
};

// Set by SES or the SDK; the SDK rejects them in `headers` too. Checked here
// first so the error is the same whatever client is behind it.
const RESERVED_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "return-path",
  "sender",
]);

// SES codes that describe this one message, so sending it again fails the same
// way. Account-level problems (sending paused, unverified sender) are left out
// on purpose: an operator can fix those and a retry then succeeds.
const PERMANENT_SES_CODES = new Set([
  "MessageRejected",
  "InvalidParameterValue",
]);

type SdkError = { name?: unknown; code?: unknown; retryable?: unknown };

function isPermanentSendError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code, retryable } = error as SdkError;
  // matched by name, not instanceof, so it works with any copy of the SDK
  if (name === "ValidationError") return true;
  // SandboxError extends SESError: an identity isn't verified (or the account
  // is sandboxed). Fixing that is an operator job, so keep retrying.
  if (name === "SESError") {
    return (
      retryable !== true &&
      typeof code === "string" &&
      PERMANENT_SES_CODES.has(code)
    );
  }
  return false;
}

/**
 * Mailer that sends through your own AWS SES account with `@wraps.dev/email`.
 * Install it alongside this package: `npm install @wraps.dev/email`.
 *
 * - `replyTo` goes to the SDK's reply-to option, never into `headers`.
 * - `headers` pass through, except reserved ones (`Reply-To`, `Message-ID`,
 *   `From`, `Subject`, ...), which throw a {@link PermanentMailError}.
 * - A malformed address or other validation failure, and an SES
 *   `MessageRejected` or `InvalidParameterValue`, throw a
 *   {@link PermanentMailError}. Everything else (throttling, network errors,
 *   missing credentials, an unverified sender) is rethrown, so the send is
 *   retried.
 * - The result is `{ id }`, where `id` is SES's message id. `messageId` is
 *   left out: SES's id is not the RFC 5322 `Message-ID` header, and the format
 *   of the header SES writes hasn't been confirmed with a real round trip.
 */
export function wrapsMailer(options: WrapsMailerOptions): Mailer {
  const { from, client: injected, ...config } = options;
  if (!from) throw new TypeError("wrapsMailer: `from` is required");

  let client: Promise<WrapsMailerClient> | undefined = injected
    ? Promise.resolve(injected)
    : undefined;
  const getClient = () => {
    // imported on first send, so the peer dependency is only needed by apps
    // that use this adapter
    client ??= import("@wraps.dev/email").then(
      ({ WrapsEmail }) => new WrapsEmail(config),
      (error) => {
        client = undefined;
        throw new Error(
          "wrapsMailer needs the `@wraps.dev/email` package: npm install @wraps.dev/email",
          { cause: error },
        );
      },
    );
    return client;
  };

  return {
    async send(message: MailMessage): Promise<MailResult> {
      const headers = copyHeaders(message.headers);
      const wraps = await getClient();
      let result: { messageId: string };
      try {
        result = await wraps.send({
          from,
          to: Array.isArray(message.to) ? [...message.to] : message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(headers ? { headers } : {}),
        });
      } catch (error) {
        if (isPermanentSendError(error)) {
          throw new PermanentMailError(
            error instanceof Error ? error.message : "Send rejected",
            { cause: error },
          );
        }
        throw error;
      }
      if (typeof result?.messageId !== "string" || !result.messageId) {
        throw new Error("wrapsMailer: the client returned no messageId");
      }
      return { id: result.messageId };
    },
  };
}

function copyHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const copy: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new PermanentMailError(
        `"${name}" is set by the mailer or the provider and can't be passed in headers` +
          (name.toLowerCase() === "reply-to" ? " (use `replyTo`)" : ""),
      );
    }
    copy[name] = value;
  }
  return Object.keys(copy).length > 0 ? copy : undefined;
}
