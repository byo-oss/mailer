import type { WrapsEmail } from "@wraps.dev/email";
import { describe, expect, it, vi } from "vitest";
import { isPermanentMailError } from "./index";
import { mailMessage, testMailer } from "./testing";
import { type WrapsMailerClient, wrapsMailer } from "./wraps";

// the real client must stay assignable to the injectable one (types only)
null as unknown as WrapsEmail satisfies WrapsMailerClient;

const ok = { messageId: "ses-1", requestId: "req-1" };

// shaped like the SDK's errors, which are matched by name
function sdkError(
  name: string,
  extra: Record<string, unknown> = {},
  message = name,
) {
  return Object.assign(new Error(message), { name, ...extra });
}

const failingWith = (error: unknown) =>
  wrapsMailer({
    from: "help@acme.test",
    client: {
      send: async () => {
        throw error;
      },
    },
  });

testMailer(
  () =>
    wrapsMailer({ from: "help@acme.test", client: { send: async () => ok } }),
  {
    failing: () => failingWith(new Error("socket hang up")),
    permanentlyFailing: () =>
      failingWith(sdkError("ValidationError", { field: "to" })),
  },
);

describe("wrapsMailer", () => {
  it("sends the message with the configured from", async () => {
    const send = vi.fn().mockResolvedValue(ok);
    const mailer = wrapsMailer({
      from: "Acme <help@acme.test>",
      client: { send },
    });

    await mailer.send(mailMessage({ to: ["a@x.test", "b@x.test"] }));

    expect(send).toHaveBeenCalledWith({
      from: "Acme <help@acme.test>",
      to: ["a@x.test", "b@x.test"],
      subject: "[#12] Re: Card declined",
      html: "<p>Hello &amp; welcome.</p>",
      text: "Hello & welcome.",
      replyTo: "support+token123@reply.example.com",
      headers: {
        "In-Reply-To": "<a1@example.com>",
        References: "<a0@example.com> <a1@example.com>",
      },
    });
  });

  it("maps replyTo to the SDK option and never into headers", async () => {
    const send = vi.fn().mockResolvedValue(ok);
    const mailer = wrapsMailer({ from: "help@acme.test", client: { send } });

    await mailer.send(mailMessage({ headers: { "X-Ticket": "12" } }));

    const params = send.mock.calls[0]?.[0];
    expect(params.replyTo).toBe("support+token123@reply.example.com");
    expect(params.headers).toEqual({ "X-Ticket": "12" });
  });

  it("omits replyTo and headers when the message has none", async () => {
    const send = vi.fn().mockResolvedValue(ok);
    const mailer = wrapsMailer({ from: "help@acme.test", client: { send } });

    await mailer.send({ to: "a@x.test", subject: "s", html: "h", text: "t" });
    await mailer.send({
      to: "a@x.test",
      subject: "s",
      html: "h",
      text: "t",
      headers: {},
    });

    for (const call of send.mock.calls) {
      expect(call[0]).not.toHaveProperty("replyTo");
      expect(call[0]).not.toHaveProperty("headers");
    }
  });

  it.each([
    "Reply-To",
    "reply-to",
    "Message-ID",
    "MESSAGE-ID",
    "From",
    "Subject",
  ])(
    "rejects the reserved header %s as permanent, before any send",
    async (name) => {
      const send = vi.fn().mockResolvedValue(ok);
      const mailer = wrapsMailer({ from: "help@acme.test", client: { send } });

      const error = await mailer
        .send(mailMessage({ headers: { [name]: "x" } }))
        .catch((e: unknown) => e);

      expect(isPermanentMailError(error)).toBe(true);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("points to replyTo when Reply-To is passed as a header", async () => {
    const mailer = wrapsMailer({
      from: "help@acme.test",
      client: { send: vi.fn() },
    });
    await expect(
      mailer.send(mailMessage({ headers: { "Reply-To": "x@y.test" } })),
    ).rejects.toThrow(/replyTo/);
  });

  it("returns the SES id as id and no messageId", async () => {
    const mailer = wrapsMailer({
      from: "help@acme.test",
      client: { send: async () => ok },
    });
    const result = await mailer.send(mailMessage());
    expect(result).toEqual({ id: "ses-1" });
    expect(result).not.toHaveProperty("messageId");
  });

  it("doesn't change the message or the headers object it was given", async () => {
    const send = vi.fn().mockImplementation(async (params) => {
      params.headers["X-Added"] = "1";
      if (Array.isArray(params.to)) params.to.push("z@x.test");
      return ok;
    });
    const mailer = wrapsMailer({ from: "help@acme.test", client: { send } });
    const message = mailMessage({ to: ["a@x.test"], headers: { "X-A": "1" } });
    const before = structuredClone(message);

    await mailer.send(message);

    expect(message).toEqual(before);
  });

  describe("error mapping", () => {
    const permanent = [
      ["a ValidationError", sdkError("ValidationError", { field: "to" })],
      [
        "an SES MessageRejected",
        sdkError("SESError", { code: "MessageRejected", retryable: false }),
      ],
      [
        "an SES InvalidParameterValue",
        sdkError("SESError", { code: "InvalidParameterValue" }),
      ],
    ] as const;

    it.each(permanent)("%s becomes a PermanentMailError", async (_, error) => {
      const caught = await failingWith(error)
        .send(mailMessage())
        .catch((e: unknown) => e);
      expect(isPermanentMailError(caught)).toBe(true);
      expect((caught as Error).message).toBe(error.message);
      expect((caught as Error).cause).toBe(error);
    });

    const retried = [
      ["a generic error", new Error("ECONNRESET")],
      [
        "throttling",
        sdkError("SESError", { code: "Throttling", retryable: true }),
      ],
      [
        "a retryable MessageRejected",
        sdkError("SESError", { code: "MessageRejected", retryable: true }),
      ],
      [
        "an unknown SES error",
        sdkError("SESError", { code: "ServiceUnavailable" }),
      ],
      [
        "an unverified identity (SandboxError)",
        sdkError("SandboxError", { code: "MessageRejected" }),
      ],
      ["missing credentials", sdkError("CredentialsError")],
      ["a thrown string", "boom"],
    ] as const;

    it.each(retried)(
      "%s is rethrown unchanged, so the send retries",
      async (_, error) => {
        const caught = await failingWith(error)
          .send(mailMessage())
          .catch((e: unknown) => e);
        expect(caught).toBe(error);
        expect(isPermanentMailError(caught)).toBe(false);
      },
    );

    it("fails with a plain error if the client returns no messageId", async () => {
      const mailer = wrapsMailer({
        from: "help@acme.test",
        client: { send: (async () => ({})) as never },
      });
      const caught = await mailer.send(mailMessage()).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(Error);
      expect(isPermanentMailError(caught)).toBe(false);
    });
  });

  it("requires from", () => {
    expect(() => wrapsMailer({ from: "" })).toThrow(TypeError);
  });
});
