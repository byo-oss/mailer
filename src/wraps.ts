import type { WrapsEmailConfig } from "@wraps.dev/email";
import { copyHeaders } from "./headers";
import {
  type Mailer,
  type MailMessage,
  type MailResult,
  PermanentMailError,
} from "./index";
import { sesMessageId } from "./ses-message-id";

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
   * resolve AWS credentials from the environment when not given. With it, the
   * other options are ignored and results have no `messageId`: the client's
   * region can't be read.
   */
  client?: WrapsMailerClient;
};

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
 * - The result is `{ id, messageId }`. `id` is SES's message id. SES
 *   replaces any `Message-ID` you set with its own, `<id@email.amazonses.com>`
 *   in us-east-1, and that is `messageId`. It is left out when the region
 *   isn't us-east-1 (AWS doesn't document the header's host, and only
 *   us-east-1 has been checked with real sends), when the region isn't known
 *   (it comes from `region`, else `AWS_REGION` or `AWS_DEFAULT_REGION`; not
 *   from an AWS profile), when `endpoint` is set, and when you pass `client`.
 */
export function wrapsMailer(options: WrapsMailerOptions): Mailer {
  const { from, client: injected, ...config } = options;
  if (!from) throw new TypeError("wrapsMailer: `from` is required");

  let client: Promise<WrapsMailerClient> | undefined = injected
    ? Promise.resolve(injected)
    : undefined;
  // The region the client sends through, for `messageId`. Only known for a
  // client built here, resolved as WrapsEmail does (the option, then the
  // environment) when the client is built, minus its AWS profile lookup, which
  // needs the AWS SDK. Unknown means no `messageId`, never a guess.
  let region: string | undefined;
  const getClient = () => {
    // imported on first send, so the peer dependency is only needed by apps
    // that use this adapter
    client ??= import("@wraps.dev/email").then(
      ({ WrapsEmail }) => {
        const env = globalThis.process?.env ?? {};
        region = config.endpoint
          ? undefined
          : config.region ||
            env.AWS_REGION ||
            env.AWS_DEFAULT_REGION ||
            undefined;
        return new WrapsEmail(config);
      },
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
      const messageId = sesMessageId(result.messageId, region);
      return messageId
        ? { id: result.messageId, messageId }
        : { id: result.messageId };
    },
  };
}
