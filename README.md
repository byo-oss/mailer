# @byo-oss/mailer

A tiny email-sender interface for [better-auth](https://better-auth.com) plugins, with a [Wraps](https://wraps.dev) adapter, an [email-sdk](https://email-sdk.dev) adapter, an in-memory mailer and a contract test suite.

> Community plugin — not affiliated with the better-auth team.

This is the shared mailer used by BYO packages (for example `@byo-oss/support`). A plugin takes a `Mailer`, so you choose how mail goes out, and the plugin never imports a provider SDK.

## Install

```
npm install @byo-oss/mailer
```

To send through your own AWS SES account with the Wraps adapter, add the SDK too (it's an optional peer dependency):

```
npm install @wraps.dev/email
```

To send through one of the providers behind [email-sdk](https://email-sdk.dev), add its client instead (also an optional peer dependency, `^3`):

```
npm install @opencoredev/email-sdk
```

## Setup

**1. Create a mailer.** With Wraps, from a server file:

```ts
// lib/mailer.ts
import { wrapsMailer } from "@byo-oss/mailer/wraps";

export const mailer = wrapsMailer({ from: "Acme Support <help@acme.com>" });
```

The sender address (or its domain) must be verified in your SES account. AWS credentials come from the environment, or pass `region`, `credentials` or a ready-made `client` (see Options).

**Or with email-sdk.** You build the client and pass it in:

```ts
// lib/mailer.ts
import { createEmailClient } from "@opencoredev/email-sdk";
import { resend } from "@opencoredev/email-sdk/resend";
import { emailSdkMailer } from "@byo-oss/mailer/email-sdk";

export const mailer = emailSdkMailer({
  from: "Acme Support <help@acme.com>",
  client: createEmailClient({
    adapters: [resend({ apiKey: process.env.RESEND_API_KEY! })],
    telemetry: false,
  }),
});
```

The sender must be verified with your provider. See Supported email-sdk adapters and Telemetry below.

**2. Hand it to the package that sends mail:**

```ts
import { support } from "@byo-oss/support";
import { mailer } from "./mailer";

betterAuth({ plugins: [support({ mailer /* ... */ })] });
```

**3. Or call it yourself:**

```ts
const { id } = await mailer.send({
  to: "alice@example.com",
  subject: "Your ticket was updated",
  html: "<p>We replied to your ticket.</p>",
  text: "We replied to your ticket.",
  replyTo: "support+t0k3n@reply.acme.com",
});
```

**4. In tests, use the in-memory mailer:**

```ts
import { memoryMailer } from "@byo-oss/mailer";

const mailer = memoryMailer();
await doSomethingThatSendsMail(mailer);
expect(mailer.sent[0]?.to).toBe("alice@example.com");
```

## Options

`wrapsMailer(options)` from `@byo-oss/mailer/wraps`:

| Option | Default | |
|---|---|---|
| `from` | required | Sender address, verified in SES: `"Acme <help@acme.com>"`. |
| `client` | a `WrapsEmail` built from the options below | A configured `new WrapsEmail({ ... })`, or any `{ send }` with the same shape (a fake, in tests). When set, the options below are ignored. |
| `region`, `credentials`, `roleArn`, ... | from the environment | Any other `@wraps.dev/email` config (`WrapsEmailConfig`), used to build the default client on the first send. |

`emailSdkMailer(options)` from `@byo-oss/mailer/email-sdk`:

| Option | Default | |
|---|---|---|
| `from` | required | Sender address, verified with your provider: `"Acme <help@acme.com>"`. Set on every message. |
| `client` | required | The result of `createEmailClient(...)`, or any object with `adapters` and `send` (a fake, in tests). It is checked when the mailer is created (see below). |

`memoryMailer(options)` from `@byo-oss/mailer`:

| Option | Default | |
|---|---|---|
| `fail` | none | `"retry"` makes every send throw a plain error; `"permanent"` throws a `PermanentMailError`. Also settable later as `mailer.fail`. |
| `reportMessageId` | `false` | Also return a `messageId`, as a provider that reports it would. |

## API

| Export | From | What it is |
|---|---|---|
| `Mailer` | `@byo-oss/mailer` | Type: `{ send(message: MailMessage): Promise<MailResult> }`. |
| `MailMessage` | `@byo-oss/mailer` | Type: `{ to: string \| string[]; subject; html; text; replyTo?; headers? }`. |
| `MailResult` | `@byo-oss/mailer` | Type: `{ id: string; messageId?: string }`. `id` is the provider's id for the send when the provider reports one; `emailSdkMailer` makes up `"<adapter>:<uuid>"` when it doesn't. `messageId` is the RFC 5322 `Message-ID` actually sent, only when the provider reports it. |
| `PermanentMailError` | `@byo-oss/mailer` | Class. Throw it from `send` for a send that can never succeed. |
| `isPermanentMailError(error)` | `@byo-oss/mailer` | Guard for it that also works when two copies of this package are installed. |
| `memoryMailer(options?)` | `@byo-oss/mailer` | A `Mailer` that records messages in `.sent` (copies), for tests and local development. Also `.clear()` and `.fail`. |
| `wrapsMailer(options)` | `@byo-oss/mailer/wraps` | A `Mailer` that sends through AWS SES with `@wraps.dev/email`. |
| `emailSdkMailer(options)` | `@byo-oss/mailer/email-sdk` | A `Mailer` that sends through an `@opencoredev/email-sdk` client. |
| `SUPPORTED_ADAPTERS` | `@byo-oss/mailer/email-sdk` | `readonly string[]`: the email-sdk adapter names `emailSdkMailer` accepts. |
| `testMailer(factory, { failing, permanentlyFailing? })` | `@byo-oss/mailer/testing` | The contract test suite, for vitest. ESM only. |

`replyTo` is its own field. Adapters map it to the provider's reply-to option and never copy it into `headers`. `headers` is for extras such as `In-Reply-To`, `References` or `List-Unsubscribe`; `wrapsMailer` and `emailSdkMailer` reject the headers the provider owns (`From`, `To`, `Subject`, `Reply-To`, `Message-ID`, `Date`, ...) with a `PermanentMailError`.

## Delivery semantics

- **Throw means retry.** Any error thrown from `send` tells the caller to try again later (a timeout, throttling, missing credentials, an unverified sender).
- **`PermanentMailError` means fail.** Throw it for a send that can never succeed, such as an invalid address or a message the provider rejected. The caller marks it failed without retrying.
- **At-least-once.** A caller can repeat a send after a crash that came after the provider accepted it, so a recipient can rarely get a duplicate. A mailer doesn't have to be idempotent.
- **The mailer never changes the message** it's given.

`wrapsMailer` maps the SDK's errors like this: a validation error (malformed address, bad header) and SES `MessageRejected` or `InvalidParameterValue` become a `PermanentMailError`; everything else, including throttling, network errors, missing credentials and a sender that isn't verified yet, is rethrown, so it retries once you fix the account.

`wrapsMailer` returns `{ id }` where `id` is the SES message id, and leaves `messageId` out. SES's id is not the RFC 5322 `Message-ID` header, and SES may replace the header you set, so the adapter doesn't claim to know it.

`emailSdkMailer` maps errors like this. email-sdk wraps adapter failures in a route error, so the mapping looks at every failure inside it, not only the outer error.

| `client.send` throws | Result |
|---|---|
| A validation error (no recipient, bad address, repeated header name). | `PermanentMailError` |
| A route error, or all-recipients-failed, where every failure is permanent by the next row. | `PermanentMailError` |
| One adapter error that is not marked retryable and has status 400 or 422. | `PermanentMailError` |
| Anything else: 401, 403, 404, 429, 5xx, no status, a 400 or 422 the adapter marks retryable, an unknown adapter, a middleware error, an abort, a non-SDK error. | Rethrown, so it retries |

Any failure inside a route error that isn't a permanent 400 or 422 makes the whole send retry. Errors without an HTTP status, such as an SMTP server's 5xx reply or Lettr rejecting every recipient, are retried until the caller gives up. email-sdk's own retry is off by default. If you turn it on, a send is retried there and again by the caller.

A 400 or 422 is permanent even when the provider uses it for an account problem (SES: sending paused, MAIL FROM domain not verified; Postmark: account pending approval). The adapters don't say which it was, so unlike `wrapsMailer`, those sends are not retried after you fix the account.

`emailSdkMailer` returns `{ id }` where `id` is the adapter's id for the send. Some adapters don't report one; then it returns `"<adapter>:<uuid>"` rather than throwing, because a throw would retry the send and could deliver it twice. It leaves `messageId` out, like `wrapsMailer`.

## Supported email-sdk adapters

BYO packages send `In-Reply-To` and `References` headers, and put a routing token in `replyTo`. An adapter has to carry both, so `emailSdkMailer` supports only these:

resend, postmark, sendgrid, cloudflare, unosend, ses, mailgun, mailersend, brevo, sparkpost, jetemail, lettermint, lettr, plunk, mailtrap, scaleway, smtp, helo.

`memory`, email-sdk's test adapter, is also accepted, for tests.

These can't carry both fields, so they are not supported: mailchimp, iterable, loops, sequenzy, primitive, zeptomail, mailpace. Neither is graph (Microsoft Graph), which only accepts `x-` headers, or sendheron, which takes one recipient.

Some supported adapters still limit what a message holds, and those sends fail with a `PermanentMailError`: lettr rejects `List-Unsubscribe`, `List-Unsubscribe-Post` and more than 10 headers; cloudflare and lettr reject display-name recipients (`"Alice <alice@example.com>"`); jetemail needs a display name in `from`.

`emailSdkMailer` reads `client.adapters` when it is created and throws a `TypeError` if any adapter is not on the list. The message names the unsupported adapters and lists the supported ones. A renamed `smtp({ name })` is rejected too, so keep the default name.

### Telemetry

The email-sdk client sends opt-out usage telemetry (adapter names, counts, redacted errors; no message content or addresses) and stores an id under your home directory. Turn it off with `createEmailClient({ telemetry: false })`, or set `EMAIL_SDK_TELEMETRY=0` or `DO_NOT_TRACK=1`. `emailSdkMailer` doesn't enforce this, because you build the client.

## Write your own adapter

Implement `Mailer` and run the contract suite against it:

```ts
// byo-mailer-postmark/src/mailer.test.ts
import { testMailer } from "@byo-oss/mailer/testing";
import { postmarkMailer } from "./mailer";

testMailer(() => postmarkMailer({ token: "test", fetch: okFetch }), {
  failing: () => postmarkMailer({ token: "test", fetch: serverErrorFetch }),
  permanentlyFailing: () =>
    postmarkMailer({ token: "test", fetch: invalidAddressFetch }),
});
```

`failing` is required, so the retry check always runs. Community adapters are separate packages named `byo-mailer-<provider>` (or the same under your own scope), and depend on this package's types and nothing else of ours.

## What this is not (yet)

- Not a template or rendering library. You pass finished `html` and `text`.
- No cc, bcc, attachments, tags or batch sending. Add them to a message type in a minor release when a package needs them.
- No queue, retries or backoff. The package that calls `send` owns those; this only says which errors to retry.
- No inbound mail. That belongs to the package that receives it.
- Wraps (AWS SES) and email-sdk are the first-party adapters. Other providers come through email-sdk, within the supported list above. Community adapters are still welcome.

## License

MIT
