# @byo-oss/mailer

A tiny email-sender interface for [better-auth](https://better-auth.com) plugins, with a [Wraps](https://wraps.dev) adapter, an AWS SES client adapter, an [email-sdk](https://email-sdk.dev) adapter, an in-memory mailer and a contract test suite.

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

To send through an SES v2 client you already have (`SESv2Client`), add the AWS SDK instead (an optional peer dependency, `^3.527.0`, the first version whose `SendEmail` types include custom `Headers`):

```
npm install @aws-sdk/client-sesv2
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

**Or with your own SES client.** If your app already has an `SESv2Client` (or a dev sink with its shape), pass it in:

```ts
// lib/mailer.ts
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { sesMailer } from "@byo-oss/mailer/ses";

export const mailer = sesMailer({
  from: "Acme Support <help@acme.com>",
  client: new SESv2Client({ region: "us-east-1" }),
});
```

It sends with SES v2 `SendEmail`. `sesMailer` is for apps that already own an `SESv2Client`. If you'd let `WrapsEmail` build the client, or your dev sink reads the SES v1 / `WrapsEmail` shape, use `wrapsMailer`: `sesMailer` gains you nothing there. If what you have is an SES v1 `SESClient`, wrap it for the Wraps adapter instead: `wrapsMailer({ from, client: new WrapsEmail({ client: sesClient }) })`.

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
    // off: no usage events to email-sdk's authors, no id file, no notice
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
| `client` | a `WrapsEmail` built from the options below | A configured `new WrapsEmail({ ... })`, or any `{ send }` with the same shape (a fake, in tests). When set, the options below are ignored and results have no `messageId`. |
| `region`, `credentials`, `roleArn`, ... | from the environment | Any other `@wraps.dev/email` config (`WrapsEmailConfig`), used to build the default client on the first send. |

`sesMailer(options)` from `@byo-oss/mailer/ses`:

| Option | Default | |
|---|---|---|
| `from` | required | Sender address, verified in SES: `"Acme <help@acme.com>"`. |
| `client` | required | Your `new SESv2Client({ ... })` from `@aws-sdk/client-sesv2`, or any `{ send(command), config? }` with the same shape (a dev sink, a fake in tests). Its region (`config.region`) is read after each send, for `messageId`. |

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
| `MailResult` | `@byo-oss/mailer` | Type: `{ id: string; messageId?: string }`. `id` is the provider's id for the send when the provider reports one; `emailSdkMailer` makes up `"<adapter>:<uuid>"` (and `sesMailer` and `wrapsMailer` `"ses:<uuid>"`) when it doesn't. `messageId` is the RFC 5322 `Message-ID` actually sent, with angle brackets, only when the adapter knows it (`wrapsMailer` and `sesMailer` in us-east-1; see Delivery semantics). |
| `PermanentMailError` | `@byo-oss/mailer` | Class. Throw it from `send` for a send that can never succeed. |
| `isPermanentMailError(error)` | `@byo-oss/mailer` | Guard for it that also works when two copies of this package are installed. |
| `memoryMailer(options?)` | `@byo-oss/mailer` | A `Mailer` that records messages in `.sent` (copies), for tests and local development. Also `.clear()` and `.fail`. |
| `wrapsMailer(options)` | `@byo-oss/mailer/wraps` | A `Mailer` that sends through AWS SES with `@wraps.dev/email`. |
| `sesMailer(options)` | `@byo-oss/mailer/ses` | A `Mailer` that sends through your `SESv2Client` with `SendEmail`. |
| `emailSdkMailer(options)` | `@byo-oss/mailer/email-sdk` | A `Mailer` that sends through an `@opencoredev/email-sdk` client. |
| `SUPPORTED_ADAPTERS` | `@byo-oss/mailer/email-sdk` | `readonly string[]`: the email-sdk adapter names `emailSdkMailer` accepts. |
| `testMailer(factory, { failing, permanentlyFailing? })` | `@byo-oss/mailer/testing` | The contract test suite, for vitest. ESM only. |

`replyTo` is its own field. Adapters map it to the provider's reply-to option and never copy it into `headers`. `headers` is for extras such as `In-Reply-To`, `References` or `List-Unsubscribe`; `wrapsMailer`, `sesMailer` and `emailSdkMailer` reject the headers the provider owns (`From`, `To`, `Subject`, `Reply-To`, `Message-ID`, `Date`, ...) with a `PermanentMailError`.

Header names and values follow RFC 5322. A name is printable ASCII (33–126) without `:`. A value is printable ASCII, spaces and tabs, on one line: no CR or LF (so no folding), no other control character and no non-ASCII text (RFC 2047-encode it first). Every mailer here, `memoryMailer` included, throws a `PermanentMailError` for anything else before it calls the provider. The contract suite checks the name rules and the line-break and control-character rules for values. A tab is valid RFC 5322 and passes this check, but SES rejects it in a value (`@wraps.dev/email` before sending, SES v2 by its `[ -~]*` value pattern), so `wrapsMailer` and `sesMailer` fail such a send with a `PermanentMailError` too.

`wrapsMailer` and `sesMailer` send a display name in `from` that has non-ASCII characters as RFC 2047 encoded-words (`Société <help@acme.com>` goes out as `=?UTF-8?B?U29jacOpdMOp?= <help@acme.com>`), as the [SES v1 `SendEmail` reference](https://docs.aws.amazon.com/ses/latest/APIReference/API_SendEmail.html) asks for `Source`, and quote an ASCII name that needs it (`Acme, Inc.`). An ASCII name that already holds an encoded-word is sent as given. The address itself is sent as given.

## Delivery semantics

- **Throw means retry.** Any error thrown from `send` tells the caller to try again later (a timeout, throttling, missing credentials, an unverified sender).
- **`PermanentMailError` means fail.** Throw it for a send that can never succeed, such as an invalid address or a message the provider rejected. The caller marks it failed without retrying.
- **At-least-once.** A caller can repeat a send after a crash that came after the provider accepted it, so a recipient can rarely get a duplicate. A mailer doesn't have to be idempotent.
- **The mailer never changes the message** it's given.

`wrapsMailer` maps the SDK's errors like this: a validation error (malformed address, bad header) and SES `MessageRejected` or `InvalidParameterValue` become a `PermanentMailError`; everything else, including throttling, network errors, missing credentials and a sender that isn't verified yet, is rethrown, so it retries once you fix the account.

`wrapsMailer` returns `{ id, messageId }`. `id` is the SES message id. SES replaces any `Message-ID` header with its own ([AWS](https://docs.aws.amazon.com/ses/latest/dg/header-fields.html): "If you provide a Message-ID header, Amazon SES overrides the header with its own value"), which in us-east-1 is `<id@email.amazonses.com>`, and that is `messageId`. AWS doesn't document the header's host, so it comes from real sends, and only us-east-1 has been checked. `messageId` is left out:

- in any other region;
- when the region isn't known: it comes from the `region` option, else `AWS_REGION` or `AWS_DEFAULT_REGION`. A region set only in an AWS profile (the shared AWS config file) isn't read, so set one of those;
- when `endpoint` is set (LocalStack, a proxy), or `AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_SES` or `AWS_ENDPOINT_URL_SESV2`, which the AWS SDK sends to. An endpoint set only in an AWS profile isn't read;
- when you pass `client`: its region can't be read.

If the client returns no message id after SES accepted the send, `id` is `"ses:<uuid>"` rather than a throw, which would send the message again. (`@wraps.dev/email` itself throws when SES returns no id, which retries the send.)

`sesMailer` maps `SendEmail` errors like this: `BadRequestException` and `MessageRejected` become a `PermanentMailError`, except a `MessageRejected` for an address or domain that isn't verified (or a sandboxed account). That one, and everything else (throttling, `LimitExceededException`, `SendingPausedException`, `AccountSuspendedException`, `MailFromDomainNotVerifiedException`, `NotFoundException`, network errors, missing credentials), is rethrown, so it retries once you fix the account.

`sesMailer` returns `{ id, messageId }` the same way: `id` is the SES message id, and `messageId` is `<id@email.amazonses.com>` when the client's region is us-east-1. It is left out in other regions, with a custom `endpoint` on the client or in `AWS_ENDPOINT_URL` or `AWS_ENDPOINT_URL_SESV2` (an endpoint set only in an AWS profile isn't read), and for a client without a readable `config.region` (most dev sinks). If the client returns no `MessageId`, `id` is `"ses:<uuid>"` rather than a throw, which would send the message again.

Confirmed with a real SES v2 simple send through `sesMailer` in us-east-1: the delivered `Message-ID` was the `messageId` it returned, and `In-Reply-To` and `References` arrived unchanged. A sender with a non-ASCII display name was accepted and delivered too, through `sesMailer` and `wrapsMailer`.

`emailSdkMailer` maps errors like this. email-sdk wraps adapter failures in a route error, so the mapping looks at every failure inside it, not only the outer error.

| `client.send` throws | Result |
|---|---|
| A validation error (no recipient, bad address, repeated header name). | `PermanentMailError` |
| A route error, or all-recipients-failed, where every failure is permanent by the next row. | `PermanentMailError` |
| One adapter error that is not marked retryable and has status 400 or 422. | `PermanentMailError` |
| Anything else: 401, 403, 404, 429, 5xx, no status, a 400 or 422 the adapter marks retryable, an unknown adapter, a middleware error, an abort, a non-SDK error. | Rethrown, so it retries |

Any failure inside a route error that isn't a permanent 400 or 422 makes the whole send retry. Errors without an HTTP status, such as an SMTP server's 5xx reply or Lettr rejecting every recipient, are retried until the caller gives up. email-sdk's own retry is off by default. If you turn it on, a send is retried there and again by the caller.

A 400 or 422 is permanent even when the provider uses it for an account problem (SES: sending paused, MAIL FROM domain not verified; Postmark: account pending approval). The adapters don't say which it was, so unlike `wrapsMailer`, those sends are not retried after you fix the account.

`emailSdkMailer` returns `{ id }` where `id` is the adapter's id for the send. Some adapters don't report one; then it returns `"<adapter>:<uuid>"` rather than throwing, because a throw would retry the send and could deliver it twice. It leaves `messageId` out: most adapters don't report the `Message-ID` they sent (email-sdk's `ses` adapter doesn't either, so use `wrapsMailer` or `sesMailer` when you need it).

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

`failing` is required, so the retry check always runs. The suite also sends malformed headers (a bad name, a value with CR, LF or another control character) and expects a `PermanentMailError` for each, so check `headers` before calling the provider. Community adapters are separate packages named `byo-mailer-<provider>` (or the same under your own scope), and depend on this package's types and nothing else of ours.

## What this is not (yet)

- Not a template or rendering library. You pass finished `html` and `text`.
- No cc, bcc, attachments, tags or batch sending. Add them to a message type in a minor release when a package needs them.
- No queue, retries or backoff. The package that calls `send` owns those; this only says which errors to retry.
- No inbound mail. That belongs to the package that receives it.
- Wraps (AWS SES), your own SES client, and email-sdk are the first-party adapters. Other providers come through email-sdk, within the supported list above. Community adapters are still welcome.

## License

MIT
