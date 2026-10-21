import { copyHeaders } from "./headers";
import {
  type Mailer,
  type MailMessage,
  type MailResult,
  PermanentMailError,
} from "./index";
import { sesMessageId } from "./ses-message-id";

/** The part of the SES v2 `SendEmail` request this adapter sends. */
export type SesSendEmailInput = {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  ReplyToAddresses?: string[];
  Content: {
    Simple: {
      Subject: { Data: string; Charset: "UTF-8" };
      Body: {
        Html: { Data: string; Charset: "UTF-8" };
        Text: { Data: string; Charset: "UTF-8" };
      };
      Headers?: { Name: string; Value: string }[];
    };
  };
};

/**
 * The part of `SESv2Client` (`@aws-sdk/client-sesv2`) this adapter uses,
 * typed by shape so a fake or a dev sink fits. `send` is given a real
 * `SendEmailCommand`, whose `input` is a {@link SesSendEmailInput}. `config`
 * is the client's resolved config, read for its region after a send.
 */
export type SesMailerClient = {
  send(command: { readonly input: SesSendEmailInput }): Promise<{
    MessageId?: string | undefined;
  }>;
  readonly config?: {
    readonly region?: unknown;
    readonly endpoint?: unknown;
    readonly isCustomEndpoint?: unknown;
  };
};

export type SesMailerOptions = {
  /** Sender address, verified in your SES account: `"Acme <help@acme.com>"`. */
  from: string;
  /** Your configured `new SESv2Client({ ... })`, or anything of that shape. */
  client: SesMailerClient;
};

type SdkError = { name?: unknown; message?: unknown; $retryable?: unknown };

function isPermanentSendError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // matched by name, not instanceof, so it works with any copy of the SDK
  const { name, message, $retryable } = error as SdkError;
  if ($retryable) return false;
  if (name === "BadRequestException") return true;
  // An unverified sender or recipient (or a sandboxed account) is also
  // MessageRejected. Fixing that is an operator job, so keep retrying.
  if (name === "MessageRejected") {
    return !(typeof message === "string" && /not verified/i.test(message));
  }
  return false;
}

// The region the client sent through, or undefined for a custom endpoint (not
// SES writing the header), a client without a readable region, or any error:
// the message is already accepted, so nothing here may throw.
async function regionOf(client: SesMailerClient): Promise<string | undefined> {
  try {
    const config = client.config;
    if (!config || config.endpoint !== undefined || config.isCustomEndpoint) {
      return undefined;
    }
    const region =
      typeof config.region === "function"
        ? await config.region()
        : config.region;
    return typeof region === "string" && region ? region : undefined;
  } catch {
    return undefined;
  }
}

type SendEmailCommandClass = new (
  input: SesSendEmailInput,
) => { readonly input: SesSendEmailInput };

let commandClass: Promise<SendEmailCommandClass> | undefined;
const getCommandClass = () => {
  // imported on first send, so the peer dependency is only needed by apps
  // that use this adapter
  commandClass ??= import("@aws-sdk/client-sesv2").then(
    ({ SendEmailCommand }) => SendEmailCommand as SendEmailCommandClass,
    (error) => {
      commandClass = undefined;
      throw new Error(
        "sesMailer needs the `@aws-sdk/client-sesv2` package: npm install @aws-sdk/client-sesv2",
        { cause: error },
      );
    },
  );
  return commandClass;
};

/**
 * Mailer that sends through an SES v2 client you already have
 * (`new SESv2Client(...)` from `@aws-sdk/client-sesv2`), with `SendEmail`.
 * Install the SDK alongside this package: `npm install @aws-sdk/client-sesv2`.
 *
 * - `replyTo` goes to `ReplyToAddresses`, never into `headers`.
 * - `headers` go to the simple message's `Headers`, except reserved ones
 *   (`Reply-To`, `Message-ID`, `From`, `Subject`, ...), which throw a
 *   {@link PermanentMailError}.
 * - A `BadRequestException` or `MessageRejected` throws a
 *   {@link PermanentMailError}, except a `MessageRejected` for an identity
 *   that isn't verified. Everything else (throttling, sending paused, an
 *   unverified MAIL FROM domain, network errors, missing credentials) is
 *   rethrown, so the send is retried.
 * - The result is `{ id, messageId }`. `id` is SES's message id. `messageId`
 *   is the `Message-ID` SES wrote, `<id@email.amazonses.com>` in us-east-1.
 *   It is left out in other regions (AWS doesn't document the header's host,
 *   and only us-east-1 has been checked with real sends), for a custom
 *   `endpoint`, and for a client whose region can't be read. If SES returns
 *   no id, `id` is `"ses:<random uuid>"` rather than an error, which would
 *   send the message again.
 */
export function sesMailer(options: SesMailerOptions): Mailer {
  const { from, client } = options;
  if (!from) throw new TypeError("sesMailer: `from` is required");
  if (!client || typeof client.send !== "function") {
    throw new TypeError(
      "sesMailer: `client` is required (a `new SESv2Client(...)`)",
    );
  }

  return {
    async send(message: MailMessage): Promise<MailResult> {
      const headers = copyHeaders(message.headers);
      const SendEmailCommand = await getCommandClass();
      const command = new SendEmailCommand({
        FromEmailAddress: from,
        Destination: {
          ToAddresses: Array.isArray(message.to)
            ? [...message.to]
            : [message.to],
        },
        ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: message.html, Charset: "UTF-8" },
              Text: { Data: message.text, Charset: "UTF-8" },
            },
            ...(headers
              ? {
                  Headers: Object.entries(headers).map(([Name, Value]) => ({
                    Name,
                    Value,
                  })),
                }
              : {}),
          },
        },
      });
      let result: { MessageId?: string | undefined };
      try {
        result = await client.send(command);
      } catch (error) {
        if (isPermanentSendError(error)) {
          const text = (error as SdkError).message;
          throw new PermanentMailError(
            typeof text === "string" && text ? text : "Send rejected",
            { cause: error },
          );
        }
        throw error;
      }
      // the message was accepted: never throw from here on, or it is sent again
      const id = result?.MessageId;
      if (typeof id !== "string" || !id) {
        return { id: `ses:${globalThis.crypto.randomUUID()}` };
      }
      const messageId = sesMessageId(id, await regionOf(client));
      return messageId ? { id, messageId } : { id };
    },
  };
}
