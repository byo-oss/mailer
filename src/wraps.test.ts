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

  it.each([
    ["CRLF in a value", { "X-Ticket": "1\r\nBcc: eve@example.com" }],
    ["a colon in a name", { "X-Ticket:": "1" }],
    ["non-ASCII text in a value", { "X-Ticket": "Café" }],
  ])("rejects %s as permanent, before any send", async (_, headers) => {
    const send = vi.fn().mockResolvedValue(ok);
    const mailer = wrapsMailer({ from: "help@acme.test", client: { send } });

    const error = await mailer
      .send(mailMessage({ headers }))
      .catch((e: unknown) => e);

    expect(isPermanentMailError(error)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends a non-ASCII display name in from RFC 2047 encoded", async () => {
    const send = vi.fn().mockResolvedValue(ok);
    const mailer = wrapsMailer({
      from: "Société Générale <help@acme.test>",
      client: { send },
    });

    await mailer.send(mailMessage());

    expect(send.mock.calls[0]?.[0].from).toBe(
      "=?UTF-8?B?U29jacOpdMOpIEfDqW7DqXJhbGU=?= <help@acme.test>",
    );
  });

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
    // a CI or dev machine with AWS_REGION or an endpoint set must not change
    // these results
    beforeEach(() => {
      vi.stubEnv("AWS_REGION", undefined);
      vi.stubEnv("AWS_DEFAULT_REGION", undefined);
      vi.stubEnv("AWS_ENDPOINT_URL", undefined);
      vi.stubEnv("AWS_ENDPOINT_URL_SES", undefined);
      vi.stubEnv("AWS_ENDPOINT_URL_SESV2", undefined);
      vi.stubEnv("AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", undefined);
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

    // the AWS SDK sends to these when set (LocalStack), and nothing in
    // WrapsEmail's config says so
    // _SESV2 too: a later @wraps.dev/email (the peer range is open) may send
    // with an SESv2Client
    it.each([
      "AWS_ENDPOINT_URL",
      "AWS_ENDPOINT_URL_SES",
      "AWS_ENDPOINT_URL_SESV2",
    ])("has no messageId with %s set", async (variable) => {
      vi.stubEnv(variable, "http://localhost:4566");
      expect(await sendWith({ region: "us-east-1" })).toEqual({
        id: "ses-1",
      });
    });

    // AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: the AWS SDK skips the endpoint
    // variables only when it is exactly "true"; any other value is not
    // "true", so the variables still count here (the SDK treats such a value
    // as unset and falls through to the profile setting, then false)
    describe("with AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", () => {
      const ENDPOINT_VARIABLES = [
        "AWS_ENDPOINT_URL",
        "AWS_ENDPOINT_URL_SES",
        "AWS_ENDPOINT_URL_SESV2",
      ];
      const LOCALSTACK = "http://localhost:4566";

      it("has the messageId with no endpoint variable", async () => {
        vi.stubEnv("AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", "true");
        expect((await sendWith({ region: "us-east-1" })).messageId).toBe(
          "<ses-1@email.amazonses.com>",
        );
      });

      it.each(ENDPOINT_VARIABLES)(
        "has the messageId with %s set and the flag true",
        async (variable) => {
          vi.stubEnv(variable, LOCALSTACK);
          vi.stubEnv("AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", "true");
          expect(await sendWith({ region: "us-east-1" })).toEqual({
            id: "ses-1",
            messageId: "<ses-1@email.amazonses.com>",
          });
        },
      );

      it.each(["false", undefined])(
        "has no messageId with AWS_ENDPOINT_URL set and the flag %s",
        async (flag) => {
          vi.stubEnv("AWS_ENDPOINT_URL", LOCALSTACK);
          vi.stubEnv("AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", flag);
          expect(await sendWith({ region: "us-east-1" })).toEqual({
            id: "ses-1",
          });
        },
      );

      // only exactly "true" ignores the variables; these must not throw
      it.each(["TRUE", "1"])(
        "has no messageId with AWS_ENDPOINT_URL set and the flag %s, and doesn't throw",
        async (flag) => {
          vi.stubEnv("AWS_ENDPOINT_URL", LOCALSTACK);
          vi.stubEnv("AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", flag);
          expect(await sendWith({ region: "us-east-1" })).toEqual({
            id: "ses-1",
          });
        },
      );

      it("has no messageId with a code-set endpoint, whatever the flag", async () => {
        vi.stubEnv("AWS_ENDPOINT_URL", LOCALSTACK);
        vi.stubEnv("AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", "true");
        expect(
          await sendWith({ region: "us-east-1", endpoint: LOCALSTACK }),
        ).toEqual({ id: "ses-1" });
      });

      it("has the messageId with an empty AWS_ENDPOINT_URL", async () => {
        vi.stubEnv("AWS_ENDPOINT_URL", "");
        expect((await sendWith({ region: "us-east-1" })).messageId).toBe(
          "<ses-1@email.amazonses.com>",
        );
      });
    });

    // SES accepted the message: a throw would make the caller send it again
    it.each([
      ["no messageId", {}],
      ["an empty messageId", { messageId: "" }],
      ["nothing", undefined],
    ])(
      "makes up an id rather than throwing when the client returns %s",
      async (_, reply) => {
        const result = await sendWith({
          client: { send: (async () => reply) as never },
        });
        expect(result.id).toMatch(/^ses:[0-9a-f-]{36}$/);
        expect(result).not.toHaveProperty("messageId");
      },
    );

    it("makes up an id on the built client in us-east-1 too, without a messageId", async () => {
      vi.spyOn(built, "send").mockResolvedValueOnce({} as never);
      const result = await sendWith({ region: "us-east-1" });
      expect(result.id).toMatch(/^ses:[0-9a-f-]{36}$/);
      expect(result).not.toHaveProperty("messageId");
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
  });

  it("requires from", () => {
    expect(() => wrapsMailer({ from: "" })).toThrow(TypeError);
  });
});
