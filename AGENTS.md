# @byo-oss/mailer

A `Mailer` is `{ send(message): Promise<{ id: string; messageId?: string }> }`. It is the shared way BYO packages (such as `@byo-oss/support`) send email. This package has no runtime dependencies.

## Using a mailer

- Server: `import { wrapsMailer } from "@byo-oss/mailer/wraps"` and `wrapsMailer({ from: "Name <addr@verified-domain>" })`. Needs `npm install @wraps.dev/email` and a sender verified in SES. Pass the result to the package that wants a `mailer`.
- Server, existing SES v2 client: `sesMailer({ from, client })` from `@byo-oss/mailer/ses`, with `client: new SESv2Client(...)` from `@aws-sdk/client-sesv2` (`^3.527.0`) or a dev sink of that shape. For a v1 `SESClient`, use `wrapsMailer({ from, client: new WrapsEmail({ client: sesClient }) })`.
- Server, other providers: `emailSdkMailer({ from, client })` from `@byo-oss/mailer/email-sdk`, with `client: createEmailClient({ adapters: [...], telemetry: false })` from `@opencoredev/email-sdk`. Supported adapters only (`SUPPORTED_ADAPTERS`); it throws a `TypeError` for the rest. Pass `telemetry: false`.
- Tests: `memoryMailer()` from `@byo-oss/mailer`. Read what was sent from `.sent`; set `.fail = "retry" | "permanent"` to simulate failures.
- `MailMessage` is `{ to, subject, html, text, replyTo?, headers? }`. Send both `html` and `text`. Put the reply address in `replyTo`, never in `headers`.
- Don't rely on `messageId` in the result. `wrapsMailer` and `sesMailer` return it (`<sesId@email.amazonses.com>`) only for us-east-1 with a known region; other regions, custom endpoints, an injected Wraps `client` and most other mailers omit it. `id` is always there.

## Implementing a mailer

1. Return `{ id }` once the provider accepted the message. Add `messageId` only if the provider tells you the RFC 5322 `Message-ID` it actually sent.
2. Throw any error to mean retry (timeouts, 5xx, throttling, bad credentials).
3. Throw `PermanentMailError` for a send that can never succeed (invalid address, rejected message). Test for it with `isPermanentMailError`, never `instanceof`.
4. Never change the message you're given, and never copy `replyTo` into `headers`. Map it to the provider's reply-to option.
5. Reject provider-owned headers (`From`, `To`, `Subject`, `Reply-To`, `Message-ID`, `Date`, ...) instead of passing them on.
6. Accept the SDK or HTTP client as an injectable option, so tests don't touch the network.
7. Run the contract suite: `testMailer(() => yourMailer(fakeOk), { failing: () => yourMailer(fakeFails), permanentlyFailing: () => yourMailer(fakeInvalid) })` from `@byo-oss/mailer/testing` (vitest, ESM only). `failing` is required.
8. Publish as `byo-mailer-<provider>` (or under your own scope). Depend on this package's types only, as a peer dependency.

## Working on this repo

- `pnpm install`, then `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:dist`.
- `@wraps.dev/email` is imported only in `src/wraps.ts`, and only dynamically on the first send. `vitest` is imported only in `src/testing.ts`. Keep both out of `src/index.ts`.
- `src/email-sdk.ts` never imports `@opencoredev/email-sdk`: the user passes the client, typed by shape (`EmailSdkMailerClient`). Only `src/email-sdk.test.ts` imports it (dev dependency). Keep it out of `src/index.ts`.
- `src/ses.ts` imports `@aws-sdk/client-sesv2` only dynamically on the first send (for `SendEmailCommand`); the client itself is passed in, typed by shape (`SesMailerClient`). Keep it out of `src/index.ts`.
- `src/headers.ts` holds the reserved-header list, shared by the adapters. `src/ses-message-id.ts` holds the SES `Message-ID` host per region, shared by `wraps.ts` and `ses.ts`: add a region only after reading a real send's header back from it (AWS doesn't document the host).
- `pnpm test:dist` (after `pnpm build`) scans `dist/`: the root references no provider SDK, the adapters load theirs only through `import()`, and every `exports` path exists. Add a new entry there.
- `./testing` is ESM only because it imports vitest.
- A public change (exports, types, error behaviour) updates the README in the same change.
- Follow the BYO conventions: https://github.com/byo-oss/conventions/blob/main/SPEC.md
