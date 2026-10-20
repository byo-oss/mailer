# @byo-oss/mailer

A `Mailer` is `{ send(message): Promise<{ id: string; messageId?: string }> }`. It is the shared way BYO packages (such as `@byo-oss/support`) send email. This package has no runtime dependencies.

## Using a mailer

- Server: `import { wrapsMailer } from "@byo-oss/mailer/wraps"` and `wrapsMailer({ from: "Name <addr@verified-domain>" })`. Needs `npm install @wraps.dev/email` and a sender verified in SES. Pass the result to the package that wants a `mailer`.
- Tests: `memoryMailer()` from `@byo-oss/mailer`. Read what was sent from `.sent`; set `.fail = "retry" | "permanent"` to simulate failures.
- `MailMessage` is `{ to, subject, html, text, replyTo?, headers? }`. Send both `html` and `text`. Put the reply address in `replyTo`, never in `headers`.
- Don't rely on `messageId` in the result: most mailers (including `wrapsMailer`) omit it. `id` is always there.

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

- `pnpm install`, then `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
- `@wraps.dev/email` is imported only in `src/wraps.ts`, and only dynamically on the first send. `vitest` is imported only in `src/testing.ts`. Keep both out of `src/index.ts`.
- `./testing` is ESM only because it imports vitest.
- A public change (exports, types, error behaviour) updates the README in the same change.
- Follow the BYO conventions: https://github.com/byo-oss/conventions/blob/main/SPEC.md
