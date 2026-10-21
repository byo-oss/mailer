import type { WrapsEmail } from "@wraps.dev/email";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPermanentMailError } from "./index";
import { mailMessage, testMailer } from "./testing";
import {
  type WrapsMailerClient,
  type WrapsMailerOptions,
  wrapsMailer,
} from "./wraps";

// the real client must stay assignable to the injectable one (types only)
null as unknown as WrapsEmail satisfies WrapsMailerClient;

// Stands in for the SDK when wrapsMailer builds its own client (no `client`
// option): records the config it was built with and answers like SES.
const built = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  send: async (_params: unknown) => ({ messageId: "ses-1", requestId: "r" }),
}));
vi.mock("@wraps.dev/email", () => ({
  WrapsEmail: class {
    constructor(config: Record<string, unknown>) {
      built.configs.push(config);
    }
    send(params: unknown) {
      return built.send(params);
    }
  },
}));

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

// the same contract on the path that builds its own client, which is the one
// that returns a messageId (in us-east-1)
testMailer(() => wrapsMailer({ from: "help@acme.test", region: "us-east-1" }), {
  failing: () => failingWith(new Error("socket hang up")),
});

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

  describe("the result", () => {
    // a CI or dev machine with AWS_REGION set must not change these results
    beforeEach(() => {
      vi.stubEnv("AWS_REGION", undefined);
      vi.stubEnv("AWS_DEFAULT_REGION", undefined);
      built.configs.length = 0;
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const sendWith = async (options: Omit<WrapsMailerOptions, "from">) =>
      wrapsMailer({ from: "help@acme.test", ...options }).send(mailMessage());

    it("in us-east-1, has the SES id and the Message-ID SES wrote", async () => {
      const result = await sendWith({ region: "us-east-1" });
      expect(result).toEqual({
        id: "ses-1",
        messageId: "<ses-1@email.amazonses.com>",
      });
      expect(built.configs).toEqual([{ region: "us-east-1" }]);
    });

    // AWS doesn't document the Message-ID host for any region, and only
    // us-east-1 has been read back from real sends
    it.each(["eu-west-1", "us-west-2", "ap-southeast-2"])(
      "in %s, has no messageId",
      async (region) => {
        expect(await sendWith({ region })).toEqual({ id: "ses-1" });
      },
    );

    it("takes the region from AWS_REGION, then AWS_DEFAULT_REGION", async () => {
      vi.stubEnv("AWS_DEFAULT_REGION", "us-east-1");
      expect((await sendWith({})).messageId).toBe(
        "<ses-1@email.amazonses.com>",
      );
      vi.stubEnv("AWS_REGION", "eu-west-1");
      expect(await sendWith({})).toEqual({ id: "ses-1" });
    });

    it("prefers the region option over the environment", async () => {
      vi.stubEnv("AWS_REGION", "eu-west-1");
      expect((await sendWith({ region: "us-east-1" })).messageId).toBe(
        "<ses-1@email.amazonses.com>",
      );
    });

    it("has no messageId when the region is unknown", async () => {
      expect(await sendWith({})).toEqual({ id: "ses-1" });
    });

    it("has no messageId with a custom endpoint", async () => {
      expect(
        await sendWith({
          region: "us-east-1",
          endpoint: "http://localhost:4566",
        }),
      ).toEqual({ id: "ses-1" });
    });

    it("has no messageId with an injected client, whatever the region", async () => {
      vi.stubEnv("AWS_REGION", "us-east-1");
      expect(
        await sendWith({
          region: "us-east-1",
          client: { send: async () => ok },
        }),
      ).toEqual({ id: "ses-1" });
      expect(built.configs).toEqual([]);
    });
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
