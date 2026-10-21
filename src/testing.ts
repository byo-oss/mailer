import { describe, expect, it } from "vitest";
import { isPermanentMailError, type Mailer, type MailMessage } from "./index";

type MailerFactory = () => Mailer | Promise<Mailer>;

export type TestMailerOptions = {
  /**
   * The same mailer wired to a transport that fails temporarily (a fake client
   * that rejects, a fetch that returns 500). Checks that `send` throws an
   * error that is not a `PermanentMailError`, which is what makes callers retry.
   */
  failing: MailerFactory;
  /**
   * The mailer wired to a transport that fails for good (an invalid address, a
   * rejected message), if it reports those. Checks that `send` throws a
   * `PermanentMailError`.
   */
  permanentlyFailing?: MailerFactory;
};

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A message with every field set. Pass overrides to vary it. */
export function mailMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    to: "alice@example.com",
    subject: "[#12] Re: Card declined",
    html: "<p>Hello &amp; welcome.</p>",
    text: "Hello & welcome.",
    replyTo: "support+token123@reply.example.com",
    headers: {
      "In-Reply-To": "<a1@example.com>",
      References: "<a0@example.com> <a1@example.com>",
    },
    ...overrides,
  };
}

// Headers no provider can send. A mailer rejects each with a
// PermanentMailError, so the failure is the same whatever is behind it.
const MALFORMED_HEADERS: readonly [string, Record<string, string>][] = [
  ["an empty name", { "": "1" }],
  ["a space in the name", { "X Ticket": "1" }],
  ["a colon in the name", { "X-Ticket:": "1" }],
  ["a non-ASCII name", { "X-Tické": "1" }],
  ["CRLF in the value", { "X-Ticket": "1\r\nBcc: eve@example.com" }],
  ["LF in the value", { "X-Ticket": "1\nBcc: eve@example.com" }],
  ["CR in the value", { "X-Ticket": "1\rx" }],
  ["NUL in the value", { "X-Ticket": "1\u0000" }],
  ["DEL in the value", { "X-Ticket": "1\u007f" }],
];

async function failureOf(mailer: Mailer, message: MailMessage) {
  try {
    await mailer.send(message);
  } catch (error) {
    return { threw: true as const, error };
  }
  return { threw: false as const };
}

/**
 * The `Mailer` contract as a vitest suite. Call it at the top level of a test
 * file with a factory that builds your mailer on a fake transport:
 *
 * ```ts
 * import { testMailer } from "@byo-oss/mailer/testing"
 * testMailer(() => myMailer({ client: fakeClient }), {
 *   failing: () => myMailer({ client: rejectingClient }),
 * })
 * ```
 *
 * It checks what callers rely on: `send` resolves with `{ id }` (a non-empty
 * string) for any valid message (one or several recipients, with or without
 * `replyTo` and `headers`), doesn't change its input (it's deep-frozen, so a
 * write throws), doesn't put `replyTo` into the `headers` it was given, throws
 * an error that is not permanent when the transport fails, throws a
 * `PermanentMailError` for a malformed header (a name that isn't printable
 * ASCII without `:`, a value with CR, LF or another control character), and
 * throws a `PermanentMailError` when `permanentlyFailing` is given. Mailers
 * aren't required to be idempotent.
 *
 * This is ESM only (it imports `vitest`).
 */
export function testMailer(create: MailerFactory, options: TestMailerOptions) {
  describe("Mailer contract", () => {
    it("has a send function", async () => {
      const mailer = await create();
      expect(typeof mailer.send).toBe("function");
    });

    it("sends a message with every field set and returns an id", async () => {
      const mailer = await create();
      const result = await mailer.send(mailMessage());
      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);
      if (result.messageId !== undefined) {
        expect(typeof result.messageId).toBe("string");
        expect(result.messageId.length).toBeGreaterThan(0);
      }
    });

    it("sends a message with only the required fields", async () => {
      const mailer = await create();
      const result = await mailer.send({
        to: "alice@example.com",
        subject: "Hi",
        html: "<p>Hi</p>",
        text: "Hi",
      });
      expect(typeof result.id).toBe("string");
    });

    it("sends to several recipients", async () => {
      const mailer = await create();
      const result = await mailer.send(
        mailMessage({ to: ["alice@example.com", "bob@example.com"] }),
      );
      expect(typeof result.id).toBe("string");
    });

    it("doesn't change the message it's given", async () => {
      const mailer = await create();
      const message = mailMessage();
      const before = structuredClone(message);
      // frozen: a write in strict mode throws, which fails the send
      await mailer.send(deepFreeze(message));
      expect(message).toEqual(before);
    });

    it("doesn't put replyTo into the headers it was given", async () => {
      const mailer = await create();
      const message = deepFreeze(
        mailMessage({ headers: { "In-Reply-To": "<a1@example.com>" } }),
      );
      await mailer.send(message);
      expect(message.headers).toEqual({ "In-Reply-To": "<a1@example.com>" });
    });

    it.each(MALFORMED_HEADERS)(
      "throws a PermanentMailError for a header with %s",
      async (_, headers) => {
        const mailer = await create();
        const outcome = await failureOf(
          mailer,
          deepFreeze(mailMessage({ headers })),
        );
        expect(outcome.threw).toBe(true);
        if (outcome.threw)
          expect(isPermanentMailError(outcome.error)).toBe(true);
      },
    );

    it("throws a non-permanent error when the send fails, so callers retry", async () => {
      const mailer = await options.failing();
      const outcome = await failureOf(mailer, mailMessage());
      expect(outcome.threw).toBe(true);
      if (outcome.threw)
        expect(isPermanentMailError(outcome.error)).toBe(false);
    });

    it.skipIf(!options.permanentlyFailing)(
      "throws a PermanentMailError for a send that can never succeed",
      async () => {
        const create = options.permanentlyFailing;
        if (!create) return;
        const outcome = await failureOf(await create(), mailMessage());
        expect(outcome.threw).toBe(true);
        if (outcome.threw)
          expect(isPermanentMailError(outcome.error)).toBe(true);
      },
    );
  });
}
