import { copyHeaders } from "./headers";
import {
  type Mailer,
  type MailMessage,
  type MailResult,
  PermanentMailError,
} from "./index";

/** The part of email-sdk's `EmailMessage` this adapter sends. */
export type EmailSdkMessage = {
  from: string;
  to: string | readonly string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: readonly { name: string; value: string }[];
};

/**
 * The part of email-sdk's `EmailClient` this adapter uses, so tests can pass a
 * fake. Typed by shape, not imported, so any copy of the package fits.
 */
export type EmailSdkMailerClient = {
  readonly adapters: ReadonlyMap<string, unknown>;
  send(message: EmailSdkMessage): Promise<{ adapter: string; id?: string }>;
};

export type EmailSdkMailerOptions = {
  /** Sender address, accepted by every adapter on the client: `"Acme <help@acme.com>"`. */
  from: string;
  /** A configured `createEmailClient({ adapters: [...], telemetry: false })`. */
  client: EmailSdkMailerClient;
};

// The adapters whose entry in email-sdk 3.0.0's `SUPPORTED_MESSAGE_FIELDS`
// (src/utils.ts) has both `headers: true` and `replyTo: true`, minus adapters
// whose validation rejects In-Reply-To or References (graph: `x-` headers
// only) or more than one recipient (sendheron, which fails the `Mailer`
// contract), plus `memory`, its test adapter. The others fail every reply:
// replies need `In-Reply-To`/`References` to thread, and `replyTo` to route
// the answer back.
export const SUPPORTED_ADAPTERS: readonly string[] = Object.freeze([
  "resend",
  "postmark",
  "sendgrid",
  "cloudflare",
  "unosend",
  "ses",
  "mailgun",
  "mailersend",
  "brevo",
  "sparkpost",
  "jetemail",
  "lettermint",
  "lettr",
  "plunk",
  "mailtrap",
  "scaleway",
  "smtp",
  "helo",
  "memory",
]);

const SUPPORTED = new Set(SUPPORTED_ADAPTERS);

type SdkError = {
  code?: unknown;
  retryable?: unknown;
  status?: unknown;
  failures?: unknown;
};

// An adapter whose provider answered 400 or 422: the API rejected this
// message, so sending it again fails the same way. `delivery` is ignored: most
// HTTP adapters report "unknown" for every error status, and a permanent error
// is never resent, so it can't cause a duplicate.
function isPermanentAdapterError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, retryable, status } = error as SdkError;
  return (
    code === "adapter_error" &&
    retryable !== true &&
    (status === 400 || status === 422)
  );
}

function isPermanentSendError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // matched by code, not instanceof, so it works with any copy of the package
  const { code, failures } = error as SdkError;
  if (code === "validation_error") return true;
  // The client wraps every adapter failure in one of these, even with a
  // single adapter. Permanent only if every adapter tried rejected it for good.
  if (code === "route_error" || code === "all_recipients_failed") {
    return (
      Array.isArray(failures) &&
      failures.length > 0 &&
      failures.every(isPermanentAdapterError)
    );
  }
  return isPermanentAdapterError(error);
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message ? message : "";
}

// A route error's own message only says every adapter failed; the reasons are
// in its failures, so those go into the message.
function permanentMessage(error: unknown): string {
  const { failures } = error as SdkError;
  const reasons = Array.isArray(failures)
    ? failures.map(messageOf).filter(Boolean).join("; ")
    : "";
  return reasons || messageOf(error) || "Send rejected";
}

/**
 * Mailer that sends through a client you build with email-sdk 3 (opencoredev's
 * `createEmailClient`), so any of its adapters that can carry replies works.
 * Install it alongside this package, and pass `telemetry: false` to
 * `createEmailClient`: the client reports usage to its authors unless told not
 * to.
 *
 * - Only adapters that send reply headers (`In-Reply-To`, `References`) and a
 *   reply-to address to several recipients are accepted: those in
 *   {@link SUPPORTED_ADAPTERS}, under their default names. Any other adapter
 *   on the client throws a `TypeError` here, not on a send.
 * - Some accepted adapters still limit what a message holds (lettr rejects
 *   `List-Unsubscribe`; cloudflare and lettr reject display-name recipients;
 *   jetemail needs a display name in `from`). Those sends throw a
 *   {@link PermanentMailError}.
 * - `replyTo` goes to the client's `replyTo`, never into `headers`.
 * - `headers` pass through as `[{ name, value }]`, except reserved ones
 *   (`Reply-To`, `Message-ID`, `From`, `Subject`, ...), which throw a
 *   {@link PermanentMailError}.
 * - A validation failure, or an adapter whose provider answered 400 or 422
 *   (from every adapter tried, when there's a fallback), throws a
 *   {@link PermanentMailError} whose message holds the adapters' reasons and
 *   whose `cause` is the client's error. Everything else (401/403/404/429/5xx,
 *   a 400 or 422 the adapter marks retryable, network errors) is rethrown, so
 *   the send is retried. Unlike `wrapsMailer`, this treats a 400 or 422 as
 *   permanent even when the provider uses it for an account problem (SES
 *   sending paused, Postmark account pending approval): the adapters don't
 *   say which it was.
 * - The result is `{ id }`, where `id` is the adapter's id for the send. Some
 *   adapters don't report one; then `id` is `"<adapter>:<random uuid>"`
 *   rather than an error, which would send the message again. `messageId` is
 *   left out: most adapters don't report the `Message-ID` they sent.
 */
export function emailSdkMailer(options: EmailSdkMailerOptions): Mailer {
  const { from, client } = options;
  if (!from) throw new TypeError("emailSdkMailer: `from` is required");
  if (!client || typeof client.adapters?.keys !== "function") {
    throw new TypeError(
      "emailSdkMailer: `client` is required (a `createEmailClient(...)` client)",
    );
  }
  const unsupported = [...client.adapters.keys()].filter(
    (name) => !SUPPORTED.has(name),
  );
  if (unsupported.length > 0) {
    throw new TypeError(
      `emailSdkMailer: unsupported email-sdk adapter(s): ${unsupported.join(", ")}. ` +
        "Replies need custom headers (In-Reply-To, References), a reply-to " +
        "address and more than one recipient per message, so only adapters " +
        "that handle all three are supported, under their default names: " +
        `${SUPPORTED_ADAPTERS.join(", ")}.`,
    );
  }

  return {
    async send(message: MailMessage): Promise<MailResult> {
      const headers = copyHeaders(message.headers);
      let result: { adapter: string; id?: string };
      try {
        result = await client.send({
          from,
          to: Array.isArray(message.to) ? [...message.to] : message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(headers
            ? {
                headers: Object.entries(headers).map(([name, value]) => ({
                  name,
                  value,
                })),
              }
            : {}),
        });
      } catch (error) {
        if (isPermanentSendError(error)) {
          throw new PermanentMailError(permanentMessage(error), {
            cause: error,
          });
        }
        throw error;
      }
      // the message was accepted: never throw from here on, or it is sent again
      if (typeof result?.id === "string" && result.id) return { id: result.id };
      const adapter =
        typeof result?.adapter === "string" && result.adapter
          ? result.adapter
          : "email-sdk";
      return { id: `${adapter}:${globalThis.crypto.randomUUID()}` };
    },
  };
}
