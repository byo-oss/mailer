import { type SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPermanentMailError } from "./index";
import { type SesMailerClient, type SesSendEmailInput, sesMailer } from "./ses";
import { mailMessage, testMailer } from "./testing";

// the real client must stay assignable to the injectable one (types only)
null as unknown as SESv2Client satisfies SesMailerClient;

const SES_ID = "0100example-0000-4000-8000-000000000001-000000";

// A stand-in for SESv2Client: records the commands, answers like SES.
function fakeClient(
  options: {
    region?: unknown;
    endpoint?: unknown;
    isCustomEndpoint?: unknown;
    config?: false;
    reply?: () => Promise<{ MessageId?: string }>;
  } = {},
) {
  const send = vi.fn<SesMailerClient["send"]>(
    options.reply ?? (async () => ({ MessageId: SES_ID })),
  );
  const client: SesMailerClient =
    options.config === false
      ? { send }
      : {
          send,
          config: {
            region:
              "region" in options ? options.region : async () => "us-east-1",
            endpoint: options.endpoint,
            isCustomEndpoint: options.isCustomEndpoint ?? false,
          },
        };
  return { client, send };
}

function inputOf(
  send: ReturnType<typeof fakeClient>["send"],
  call = 0,
): SesSendEmailInput {
  const command = send.mock.calls[call]?.[0];
  if (!command) throw new Error(`no send call ${call}`);
  return command.input;
}

// shaped like the SDK's errors, which are matched by name
function sdkError(
  name: string,
  message = name,
  extra: Record<string, unknown> = {},
) {
  return Object.assign(new Error(message), {
    name,
    $fault: "client",
    $metadata: {},
    ...extra,
  });
}

const failingWith = (error: unknown) =>
  sesMailer({
    from: "help@acme.test",
    client: fakeClient({
      reply: async () => {
        throw error;
      },
    }).client,
  });

testMailer(
  () => sesMailer({ from: "help@acme.test", client: fakeClient().client }),
  {
    failing: () => failingWith(new Error("socket hang up")),
    permanentlyFailing: () =>
      failingWith(sdkError("BadRequestException", "Missing final '@domain'")),
  },
);

describe("sesMailer", () => {
  it("sends a SendEmailCommand with the message as simple content", async () => {
    const { client, send } = fakeClient();
    const mailer = sesMailer({ from: "Acme <help@acme.test>", client });

    await mailer.send(mailMessage({ to: ["a@x.test", "b@x.test"] }));

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(inputOf(send)).toEqual({
      FromEmailAddress: "Acme <help@acme.test>",
      Destination: { ToAddresses: ["a@x.test", "b@x.test"] },
      ReplyToAddresses: ["support+token123@reply.example.com"],
      Content: {
        Simple: {
          Subject: { Data: "[#12] Re: Card declined", Charset: "UTF-8" },
          Body: {
            Html: { Data: "<p>Hello &amp; welcome.</p>", Charset: "UTF-8" },
            Text: { Data: "Hello & welcome.", Charset: "UTF-8" },
          },
          Headers: [
            { Name: "In-Reply-To", Value: "<a1@example.com>" },
            { Name: "References", Value: "<a0@example.com> <a1@example.com>" },
          ],
        },
      },
    });
  });

  it("sends one recipient as a one-item list", async () => {
    const { client, send } = fakeClient();
    await sesMailer({ from: "help@acme.test", client }).send(
      mailMessage({ to: "a@x.test" }),
    );
    expect(inputOf(send).Destination).toEqual({ ToAddresses: ["a@x.test"] });
  });

  it("maps replyTo to ReplyToAddresses and never into Headers", async () => {
    const { client, send } = fakeClient();
    await sesMailer({ from: "help@acme.test", client }).send(
      mailMessage({ headers: { "X-Ticket": "12" } }),
    );
    const input = inputOf(send);
    expect(input.ReplyToAddresses).toEqual([
      "support+token123@reply.example.com",
    ]);
    expect(input.Content.Simple.Headers).toEqual([
      { Name: "X-Ticket", Value: "12" },
    ]);
  });

  it("omits ReplyToAddresses and Headers when the message has none", async () => {
    const { client, send } = fakeClient();
    const mailer = sesMailer({ from: "help@acme.test", client });

    await mailer.send({ to: "a@x.test", subject: "s", html: "h", text: "t" });
    await mailer.send({
      to: "a@x.test",
      subject: "s",
      html: "h",
      text: "t",
      headers: {},
    });

    expect(send).toHaveBeenCalledTimes(2);
    for (const call of [0, 1]) {
      const input = inputOf(send, call);
      expect(input).not.toHaveProperty("ReplyToAddresses");
      expect(input.Content.Simple).not.toHaveProperty("Headers");
    }
  });

  it.each(["Reply-To", "Message-ID", "From", "Subject"])(
    "rejects the reserved header %s as permanent, before any send",
    async (name) => {
      const { client, send } = fakeClient();
      const error = await sesMailer({ from: "help@acme.test", client })
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
    const { client, send } = fakeClient();
    const error = await sesMailer({ from: "help@acme.test", client })
      .send(mailMessage({ headers }))
      .catch((e: unknown) => e);
    expect(isPermanentMailError(error)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  describe("from", () => {
    const fromSent = async (from: string) => {
      const { client, send } = fakeClient();
      await sesMailer({ from, client }).send(mailMessage());
      return inputOf(send).FromEmailAddress;
    };

    it("sends a non-ASCII display name RFC 2047 encoded", async () => {
      expect(await fromSent("Société Générale <help@acme.test>")).toBe(
        "=?UTF-8?B?U29jacOpdMOpIEfDqW7DqXJhbGU=?= <help@acme.test>",
      );
    });

    it("quotes an ASCII display name that needs it", async () => {
      expect(await fromSent("Acme, Inc. <help@acme.test>")).toBe(
        '"Acme, Inc." <help@acme.test>',
      );
    });

    it.each([
      "help@acme.test",
      "Acme Support <help@acme.test>",
      '"Acme, Inc." <help@acme.test>',
    ])("sends %s unchanged", async (from) => {
      expect(await fromSent(from)).toBe(from);
    });
  });

  describe("the result", () => {
    // a dev machine with an endpoint set must not change these results
    beforeEach(() => {
      vi.stubEnv("AWS_ENDPOINT_URL", undefined);
      vi.stubEnv("AWS_ENDPOINT_URL_SESV2", undefined);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("in us-east-1, has the SES id and the Message-ID SES wrote", async () => {
      const { client } = fakeClient({ region: async () => "us-east-1" });
      const result = await sesMailer({ from: "help@acme.test", client }).send(
        mailMessage(),
      );
      expect(result).toEqual({
        id: SES_ID,
        messageId: `<${SES_ID}@email.amazonses.com>`,
      });
    });

    it("reads a region set as a plain string too", async () => {
      const { client } = fakeClient({ region: "us-east-1" });
      const result = await sesMailer({ from: "help@acme.test", client }).send(
        mailMessage(),
      );
      expect(result.messageId).toBe(`<${SES_ID}@email.amazonses.com>`);
    });

    // AWS doesn't document the Message-ID host for any region, and only
    // us-east-1 has been read back from real sends
    it.each(["eu-west-1", "us-west-2", "ap-southeast-2"])(
      "in %s, has no messageId",
      async (region) => {
        const { client } = fakeClient({ region: async () => region });
        const result = await sesMailer({ from: "help@acme.test", client }).send(
          mailMessage(),
        );
        expect(result).toEqual({ id: SES_ID });
      },
    );

    it.each([
      ["a client without config (a dev sink)", fakeClient({ config: false })],
      ["a region that isn't a string", fakeClient({ region: async () => 42 })],
      [
        "a region provider that rejects",
        fakeClient({
          region: async () => {
            throw new Error("Region is missing");
          },
        }),
      ],
      [
        "a custom endpoint",
        fakeClient({
          endpoint: async () => ({ hostname: "localhost" }),
          isCustomEndpoint: true,
        }),
      ],
    ])("for %s, has no messageId and doesn't throw", async (_, { client }) => {
      const result = await sesMailer({ from: "help@acme.test", client }).send(
        mailMessage(),
      );
      expect(result).toEqual({ id: SES_ID });
    });

    // the AWS SDK sends to these when set (LocalStack), but the client's
    // config doesn't show it
    it.each(["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_SESV2"])(
      "has no messageId with %s set",
      async (variable) => {
        vi.stubEnv(variable, "http://localhost:4566");
        const { client } = fakeClient({ region: async () => "us-east-1" });
        const result = await sesMailer({ from: "help@acme.test", client }).send(
          mailMessage(),
        );
        expect(result).toEqual({ id: SES_ID });
      },
    );

    it("makes up an id rather than throwing when SES returns none", async () => {
      const { client } = fakeClient({ reply: async () => ({}) });
      const result = await sesMailer({ from: "help@acme.test", client }).send(
        mailMessage(),
      );
      expect(result.id).toMatch(/^ses:[0-9a-f-]{36}$/);
      expect(result).not.toHaveProperty("messageId");
    });
  });

  describe("error mapping", () => {
    const permanent = [
      [
        "a BadRequestException",
        sdkError("BadRequestException", "Illegal address"),
      ],
      ["a MessageRejected", sdkError("MessageRejected", "Message rejected")],
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
        "an unverified identity (MessageRejected)",
        sdkError(
          "MessageRejected",
          "Email address is not verified. The following identities failed the check in region US-EAST-1: help@acme.test",
        ),
      ],
      [
        "a retryable MessageRejected",
        sdkError("MessageRejected", "Message rejected", {
          $retryable: { throttling: false },
        }),
      ],
      ["throttling", sdkError("TooManyRequestsException")],
      ["a sending limit", sdkError("LimitExceededException")],
      ["sending paused", sdkError("SendingPausedException")],
      ["a suspended account", sdkError("AccountSuspendedException")],
      [
        "an unverified MAIL FROM domain",
        sdkError("MailFromDomainNotVerifiedException"),
      ],
      ["a missing configuration set", sdkError("NotFoundException")],
      ["missing credentials", sdkError("CredentialsProviderError")],
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

  it("requires from and a client", () => {
    const { client } = fakeClient();
    expect(() => sesMailer({ from: "", client })).toThrow(TypeError);
    expect(() =>
      sesMailer({ from: "help@acme.test", client: undefined as never }),
    ).toThrow(TypeError);
  });
});

// A real SESv2Client whose HTTP layer is stubbed: checks the SDK serializes
// what the adapter builds (Headers included) and that its region is read.
describe("sesMailer with a real SESv2Client", () => {
  beforeEach(() => {
    vi.stubEnv("AWS_ENDPOINT_URL", undefined);
    vi.stubEnv("AWS_ENDPOINT_URL_SESV2", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function realClient(region: string, extra: { endpoint?: string } = {}) {
    const { SESv2Client } = await import("@aws-sdk/client-sesv2");
    const requests: { hostname: string; path: string; body: string }[] = [];
    const client = new SESv2Client({
      region,
      ...extra,
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      requestHandler: {
        handle: async (request: {
          hostname: string;
          path: string;
          body: string;
        }) => {
          requests.push(request);
          return {
            response: {
              statusCode: 200,
              headers: { "content-type": "application/json" },
              body: new TextEncoder().encode(
                JSON.stringify({ MessageId: SES_ID }),
              ),
            },
          };
        },
      } as never,
    });
    return { client, requests };
  }

  it("sends the headers and returns the Message-ID in us-east-1", async () => {
    const { client, requests } = await realClient("us-east-1");
    const result = await sesMailer({ from: "help@acme.test", client }).send(
      mailMessage(),
    );

    expect(result).toEqual({
      id: SES_ID,
      messageId: `<${SES_ID}@email.amazonses.com>`,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.hostname).toBe("email.us-east-1.amazonaws.com");
    expect(requests[0]?.path).toBe("/v2/email/outbound-emails");
    const body = JSON.parse(String(requests[0]?.body));
    expect(body.Content.Simple.Headers).toEqual([
      { Name: "In-Reply-To", Value: "<a1@example.com>" },
      { Name: "References", Value: "<a0@example.com> <a1@example.com>" },
    ]);
    expect(body.ReplyToAddresses).toEqual([
      "support+token123@reply.example.com",
    ]);
  });

  it.each(["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_SESV2"])(
    "sends to the endpoint in %s and returns no messageId",
    async (variable) => {
      vi.stubEnv(variable, "http://localhost:4566");
      const { client, requests } = await realClient("us-east-1");
      const result = await sesMailer({ from: "help@acme.test", client }).send(
        mailMessage(),
      );
      expect(requests[0]?.hostname).toBe("localhost");
      expect(result).toEqual({ id: SES_ID });
    },
  );

  it("sends to an endpoint option and returns no messageId", async () => {
    const { client, requests } = await realClient("us-east-1", {
      endpoint: "http://localhost:4566",
    });
    const result = await sesMailer({ from: "help@acme.test", client }).send(
      mailMessage(),
    );
    expect(requests[0]?.hostname).toBe("localhost");
    expect(result).toEqual({ id: SES_ID });
  });

  it("returns no messageId in another region", async () => {
    const { client } = await realClient("eu-west-1");
    const result = await sesMailer({ from: "help@acme.test", client }).send(
      mailMessage(),
    );
    expect(result).toEqual({ id: SES_ID });
  });
});
