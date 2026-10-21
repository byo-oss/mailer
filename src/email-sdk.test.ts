import {
  createEmailClient,
  type EmailAdapter,
  EmailAdapterError,
  type EmailClient,
  SUPPORTED_MESSAGE_FIELDS,
} from "@opencoredev/email-sdk";
import { graph } from "@opencoredev/email-sdk/graph";
import { loops } from "@opencoredev/email-sdk/loops";
import { mailchimp } from "@opencoredev/email-sdk/mailchimp";
import { postmark } from "@opencoredev/email-sdk/postmark";
import { resend } from "@opencoredev/email-sdk/resend";
import { sendheron } from "@opencoredev/email-sdk/sendheron";
import { ses } from "@opencoredev/email-sdk/ses";
import { smtp } from "@opencoredev/email-sdk/smtp";
import { memoryAdapter } from "@opencoredev/email-sdk/testing";
import { zeptomail } from "@opencoredev/email-sdk/zeptomail";
import { describe, expect, it, vi } from "vitest";
import {
  type EmailSdkMailerClient,
  emailSdkMailer,
  SUPPORTED_ADAPTERS,
} from "./email-sdk";
import { isPermanentMailError } from "./index";
import { mailMessage, testMailer } from "./testing";

// the real client must stay assignable to the injectable one (types only)
null as unknown as EmailClient satisfies EmailSdkMailerClient;

// every real client in this file: telemetry off, so tests never reach PostHog
// or write an id under the home directory
const realClient = (...adapters: EmailAdapter[]) =>
  createEmailClient({ adapters, telemetry: false });

// A stand-in for an HTTP adapter that throws the SDK's own error. Named
// "memory" because the name must be in SUPPORTED_ADAPTERS and this one is
// their test adapter's, so it doesn't pose as a real provider.
function throwingAdapter(error: Error): EmailAdapter {
  return {
    name: "memory",
    capabilities: {
      repeatedHeaders: true,
      idempotency: "none",
      scheduling: false,
      personalized: "expanded",
    },
    send() {
      throw error;
    },
  };
}

const unavailable = () =>
  new EmailAdapterError("Provider failed with 503", {
    adapter: "memory",
    status: 503,
    retryable: true,
  });

const unprocessable = () =>
  new EmailAdapterError("Provider failed with 422: invalid recipient", {
    adapter: "memory",
    status: 422,
    delivery: "not_sent",
  });

testMailer(
  () =>
    emailSdkMailer({
      from: "help@acme.test",
      client: realClient(memoryAdapter()),
    }),
  {
    failing: () =>
      emailSdkMailer({
        from: "help@acme.test",
        client: realClient(throwingAdapter(unavailable())),
      }),
    permanentlyFailing: () =>
      emailSdkMailer({
        from: "help@acme.test",
        client: realClient(throwingAdapter(unprocessable())),
      }),
  },
);

const fakeAdapters = new Map([["resend", {}]]);

const fakeClient = (
  send: EmailSdkMailerClient["send"],
): EmailSdkMailerClient => ({ adapters: fakeAdapters, send });

const failingWith = (error: unknown) =>
  emailSdkMailer({
    from: "help@acme.test",
    client: fakeClient(async () => {
      throw error;
    }),
  });

// shaped like the SDK's errors (matched by fields), but not its classes
function sdkError(fields: Record<string, unknown>, message = "SDK error") {
  return Object.assign(new Error(message), fields);
}

const adapterError = (fields: Record<string, unknown>, message?: string) =>
  sdkError(
    { name: "EmailAdapterError", code: "adapter_error", ...fields },
    message,
  );

describe("emailSdkMailer", () => {
  describe("through a real client", () => {
    it("hands the adapter from, to, replyTo and [{ name, value }] headers", async () => {
      const adapter = memoryAdapter();
      const mailer = emailSdkMailer({
        from: "Acme <help@acme.test>",
        client: realClient(adapter),
      });

      const result = await mailer.send(
        mailMessage({ to: ["a@x.test", "b@x.test"] }),
      );

      const sent = adapter.raw?.sent[0]?.message;
      expect(sent).toEqual({
        from: "Acme <help@acme.test>",
        to: ["a@x.test", "b@x.test"],
        subject: "[#12] Re: Card declined",
        html: "<p>Hello &amp; welcome.</p>",
        text: "Hello & welcome.",
        replyTo: "support+token123@reply.example.com",
        headers: [
          { name: "In-Reply-To", value: "<a1@example.com>" },
          { name: "References", value: "<a0@example.com> <a1@example.com>" },
        ],
      });
      expect(
        sent?.headers?.some((h) => h.name.toLowerCase() === "reply-to"),
      ).toBe(false);
      expect(result).toEqual({ id: "mem_1" });
      expect(result).not.toHaveProperty("messageId");
    });

    it("omits replyTo and headers when the message has none", async () => {
      const adapter = memoryAdapter();
      const mailer = emailSdkMailer({
        from: "help@acme.test",
        client: realClient(adapter),
      });

      await mailer.send({
        to: "a@x.test",
        subject: "s",
        html: "h",
        text: "t",
        headers: {},
      });

      const sent = adapter.raw?.sent[0]?.message;
      expect(sent?.to).toBe("a@x.test");
      expect(sent).not.toHaveProperty("replyTo");
      expect(sent).not.toHaveProperty("headers");
    });

    it.each(["Reply-To", "reply-to", "Message-ID", "From", "Subject"])(
      "rejects the reserved header %s as permanent, before any send",
      async (name) => {
        const adapter = memoryAdapter();
        const client = realClient(adapter);
        const send = vi.spyOn(client, "send");
        const mailer = emailSdkMailer({ from: "help@acme.test", client });

        const error = await mailer
          .send(mailMessage({ headers: { [name]: "x" } }))
          .catch((e: unknown) => e);

        expect(isPermanentMailError(error)).toBe(true);
        expect(send).not.toHaveBeenCalled();
        expect(adapter.raw?.sent).toHaveLength(0);
      },
    );

    it("points to replyTo when Reply-To is passed as a header", async () => {
      const mailer = emailSdkMailer({
        from: "help@acme.test",
        client: realClient(memoryAdapter()),
      });
      await expect(
        mailer.send(mailMessage({ headers: { "Reply-To": "x@y.test" } })),
      ).rejects.toThrow(/replyTo/);
    });

    // the client wraps even a single adapter's failure in a route_error
    it("sees through the client's route_error to the adapter's 422", async () => {
      const thrown = unprocessable();
      const mailer = emailSdkMailer({
        from: "help@acme.test",
        client: realClient(throwingAdapter(thrown)),
      });

      const caught = await mailer.send(mailMessage()).catch((e: unknown) => e);

      expect(isPermanentMailError(caught)).toBe(true);
      const cause = (caught as Error).cause as {
        code: string;
        failures: unknown[];
      };
      expect(cause.code).toBe("route_error");
      expect(cause.failures).toEqual([thrown]);
      expect(cause.failures[0]).toBe(thrown);
      // the provider's reason, not the route error's "All ... failed."
      expect((caught as Error).message).toBe(
        "Provider failed with 422: invalid recipient",
      );
    });

    it("rethrows the client's route_error unchanged for a 503", async () => {
      const thrown = unavailable();
      const mailer = emailSdkMailer({
        from: "help@acme.test",
        client: realClient(throwingAdapter(thrown)),
      });

      const caught = await mailer.send(mailMessage()).catch((e: unknown) => e);

      expect(isPermanentMailError(caught)).toBe(false);
      expect((caught as { code?: unknown }).code).toBe("route_error");
      expect((caught as { failures?: unknown[] }).failures?.[0]).toBe(thrown);
    });

    describe.each([
      {
        name: "resend",
        provider: "Resend",
        adapter: (fetch: typeof globalThis.fetch) =>
          resend({ apiKey: "re_test", fetch }),
        accepted: { id: "re_123" },
        id: "re_123",
        sentFields: (body: Record<string, unknown>) => ({
          headers: body.headers,
          replyTo: body.reply_to,
        }),
        headers: {
          "In-Reply-To": "<a1@example.com>",
          References: "<a0@example.com> <a1@example.com>",
        },
        replyTo: ["support+token123@reply.example.com"],
      },
      {
        name: "postmark",
        provider: "Postmark",
        adapter: (fetch: typeof globalThis.fetch) =>
          postmark({ serverToken: "pm_test", fetch }),
        accepted: { MessageID: "pm_123" },
        id: "pm_123",
        sentFields: (body: Record<string, unknown>) => ({
          headers: body.Headers,
          replyTo: body.ReplyTo,
        }),
        headers: [
          { Name: "In-Reply-To", Value: "<a1@example.com>" },
          { Name: "References", Value: "<a0@example.com> <a1@example.com>" },
        ],
        replyTo: "support+token123@reply.example.com",
      },
    ])("over a real $name adapter (fake fetch)", (setup) => {
      function mailerAnswering(status: number, body: unknown) {
        const fetch = vi.fn(
          async (_url: string | URL | Request, _init?: RequestInit) =>
            new Response(JSON.stringify(body), {
              status,
              headers: { "Content-Type": "application/json" },
            }),
        );
        const mailer = emailSdkMailer({
          from: "help@acme.test",
          client: createEmailClient({
            adapters: [setup.adapter(fetch)],
            telemetry: false,
          }),
        });
        return { mailer, fetch };
      }

      it("makes a 422 permanent, with the provider's reason in the message", async () => {
        const { mailer } = mailerAnswering(422, {
          message: "Invalid `to` field.",
        });

        const caught = await mailer
          .send(mailMessage())
          .catch((e: unknown) => e);

        expect(isPermanentMailError(caught)).toBe(true);
        expect((caught as Error).message).toContain(
          `${setup.provider} failed with 422`,
        );
        const failure = (
          (caught as Error).cause as { failures: Record<string, unknown>[] }
        ).failures[0];
        // what the real adapter reports: no "not_sent"
        expect(failure).toMatchObject({ code: "adapter_error", status: 422 });
      });

      it("rethrows a 503 so the send retries", async () => {
        const { mailer } = mailerAnswering(503, { message: "Unavailable" });

        const caught = await mailer
          .send(mailMessage())
          .catch((e: unknown) => e);

        expect(caught).toBeInstanceOf(Error);
        expect(isPermanentMailError(caught)).toBe(false);
      });

      it("returns the provider's id and sends headers and reply-to", async () => {
        const { mailer, fetch } = mailerAnswering(200, setup.accepted);

        const result = await mailer.send(mailMessage());

        expect(result).toEqual({ id: setup.id });
        const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
        expect(setup.sentFields(body)).toEqual({
          headers: setup.headers,
          replyTo: setup.replyTo,
        });
      });
    });

    it("makes the client's own validation_error permanent", async () => {
      const mailer = emailSdkMailer({
        from: "help@acme.test",
        client: realClient(memoryAdapter()),
      });

      const caught = await mailer
        .send(mailMessage({ subject: "" }))
        .catch((e: unknown) => e);

      expect(isPermanentMailError(caught)).toBe(true);
      expect(((caught as Error).cause as { code?: unknown }).code).toBe(
        "validation_error",
      );
    });
  });

  describe("error mapping", () => {
    const failure = (status: number) =>
      adapterError(
        { status, retryable: false, delivery: "not_sent" },
        `Provider failed with ${status}`,
      );

    const permanent = [
      [
        "validation_error",
        { code: "validation_error", message: "Email requires a subject." },
        "Email requires a subject.",
      ],
      [
        "route_error whose failures are all permanent",
        sdkError(
          { code: "route_error", failures: [failure(422), failure(400)] },
          "All configured email adapters failed.",
        ),
        "Provider failed with 422; Provider failed with 400",
      ],
      [
        "all_recipients_failed whose failures are all permanent",
        sdkError(
          { code: "all_recipients_failed", failures: [failure(422)] },
          "All personalized email recipients failed.",
        ),
        "Provider failed with 422",
      ],
      [
        "route_error whose permanent failures have no message",
        sdkError(
          {
            code: "route_error",
            failures: [
              { code: "adapter_error", status: 400, delivery: "not_sent" },
            ],
          },
          "All configured email adapters failed.",
        ),
        "All configured email adapters failed.",
      ],
      [
        "adapter_error 400, not_sent, not retryable",
        adapterError({ status: 400, delivery: "not_sent" }, "Bad request"),
        "Bad request",
      ],
      [
        "adapter_error 422, not_sent, retryable false",
        adapterError(
          { status: 422, delivery: "not_sent", retryable: false },
          "Unprocessable",
        ),
        "Unprocessable",
      ],
      [
        "plain-object adapter_error 422, not_sent",
        { code: "adapter_error", status: 422, delivery: "not_sent" },
        "Send rejected",
      ],
      // HTTP adapters report delivery "unknown" for every error status, so
      // delivery doesn't decide: the provider's API answered with a client error
      [
        "adapter_error 422 with delivery unknown",
        adapterError({ status: 422, delivery: "unknown" }, "Unprocessable"),
        "Unprocessable",
      ],
      [
        "adapter_error 400 without delivery",
        adapterError({ status: 400 }, "Bad request"),
        "Bad request",
      ],
      [
        "adapter_error 422 without delivery",
        adapterError({ status: 422, retryable: false }, "Unprocessable"),
        "Unprocessable",
      ],
      [
        "route_error whose only failure is a 422 with delivery unknown",
        sdkError(
          {
            code: "route_error",
            failures: [
              adapterError(
                { status: 422, retryable: false, delivery: "unknown" },
                "Resend failed with 422: invalid to",
              ),
            ],
          },
          "All configured email adapters failed.",
        ),
        "Resend failed with 422: invalid to",
      ],
    ] as const;

    it.each(permanent)(
      "%s becomes a PermanentMailError",
      async (_, error, message) => {
        const caught = await failingWith(error)
          .send(mailMessage())
          .catch((e: unknown) => e);
        expect(isPermanentMailError(caught)).toBe(true);
        expect((caught as Error).cause).toBe(error);
        expect((caught as Error).message).toBe(message);
      },
    );

    const retried = [
      [
        "route_error with mixed failures",
        sdkError({
          code: "route_error",
          failures: [failure(422), failure(503)],
        }),
      ],
      [
        "all_recipients_failed with mixed failures",
        sdkError({
          code: "all_recipients_failed",
          failures: [failure(400), adapterError({ status: 429 })],
        }),
      ],
      [
        "route_error with empty failures",
        sdkError({ code: "route_error", failures: [] }),
      ],
      ["route_error without failures", sdkError({ code: "route_error" })],
      ["adapter_error 401 not_sent", failure(401)],
      ["adapter_error 403 not_sent", failure(403)],
      ["adapter_error 404 not_sent", failure(404)],
      ["adapter_error 429 not_sent", failure(429)],
      ["adapter_error 500 not_sent", failure(500)],
      ["adapter_error 503 not_sent", failure(503)],
      [
        "adapter_error 400 with retryable true",
        adapterError({ status: 400, delivery: "not_sent", retryable: true }),
      ],
      ["adapter_error with no status", adapterError({ delivery: "not_sent" })],
      [
        "adapter_not_found",
        sdkError({ code: "adapter_not_found", adapter: "resend" }),
      ],
      [
        "middleware_error",
        sdkError({ code: "middleware_error", phase: "before_send" }),
      ],
      ["aborted", sdkError({ code: "aborted" })],
      ["a non-SDK error", new Error("ECONNRESET")],
      [
        "a 422 status without the adapter_error code",
        sdkError({ status: 422, delivery: "not_sent" }),
      ],
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

  describe("id", () => {
    it("returns the adapter's id", async () => {
      const mailer = emailSdkMailer({
        from: "help@acme.test",
        client: fakeClient(async () => ({ adapter: "resend", id: "re_123" })),
      });
      expect(await mailer.send(mailMessage())).toEqual({ id: "re_123" });
    });

    it.each([
      ["no id", { adapter: "resend" }],
      ["an empty id", { adapter: "resend", id: "" }],
    ])(
      "falls back to <adapter>:<uuid> when the result has %s",
      async (_, result) => {
        const mailer = emailSdkMailer({
          from: "help@acme.test",
          client: fakeClient(async () => result),
        });

        const first = await mailer.send(mailMessage());
        const second = await mailer.send(mailMessage());

        expect(first.id).toMatch(/^resend:[0-9a-f-]{36}$/);
        expect(second.id).not.toBe(first.id);
        expect(first).not.toHaveProperty("messageId");
      },
    );
  });

  describe("supported adapters", () => {
    it("lists exactly the adapters email-sdk says carry headers and replyTo, plus memory", () => {
      const fields = SUPPORTED_MESSAGE_FIELDS as Record<
        string,
        { headers?: boolean; replyTo?: boolean }
      >;
      const expected = Object.entries(fields)
        .filter(([, f]) => f.headers === true && f.replyTo === true)
        .map(([name]) => name)
        // graph's validation only accepts x- headers, so In-Reply-To and
        // References can never go through it; sendheron takes one recipient
        .filter((name) => name !== "graph" && name !== "sendheron");

      expect([...SUPPORTED_ADAPTERS].sort()).toEqual(
        [...expected, "memory"].sort(),
      );
    });

    it("accepts real resend, ses and smtp adapters", () => {
      // built inline, as the README shows, so the literal adapter names
      // ("resend" | "ses" | "smtp") are type-checked against the client type
      const client = createEmailClient({
        adapters: [
          resend({ apiKey: "re_test" }),
          ses({
            accessKeyId: "AKIATEST",
            secretAccessKey: "secret",
            region: "us-east-1",
          }),
          smtp({ host: "smtp.example.test" }),
        ],
        telemetry: false,
      });
      expect(() =>
        emailSdkMailer({ from: "help@acme.test", client }),
      ).not.toThrow();
    });

    it.each([
      ["zeptomail", () => zeptomail({ token: "test" })],
      ["loops", () => loops({ apiKey: "test", transactionalId: "tx_1" })],
      ["mailchimp", () => mailchimp({ apiKey: "test" })],
      [
        "graph",
        () => graph({ user: "help@acme.test", getAccessToken: () => "token" }),
      ],
      ["sendheron", () => sendheron({ apiKey: "test" })],
    ])("rejects %s with a TypeError naming it", (name, adapter) => {
      const client = realClient(adapter());
      const create = () => emailSdkMailer({ from: "help@acme.test", client });

      expect(create).toThrow(TypeError);
      expect(create).toThrow(new RegExp(`unsupported .*\\b${name}\\b`));
    });

    it("rejects a client mixing a supported adapter with an unsupported one", () => {
      const client = realClient(
        resend({ apiKey: "re_test" }),
        loops({ apiKey: "test", transactionalId: "tx_1" }),
      );
      const create = () => emailSdkMailer({ from: "help@acme.test", client });

      expect(create).toThrow(TypeError);
      expect(create).toThrow(/adapter\(s\): loops\./);
    });

    it("rejects a renamed smtp adapter", () => {
      const client = realClient(
        smtp({ name: "custom", host: "smtp.example.test" }),
      );
      expect(() => emailSdkMailer({ from: "help@acme.test", client })).toThrow(
        /adapter\(s\): custom\./,
      );
    });

    it("says why and lists the supported adapters", () => {
      const client = realClient(mailchimp({ apiKey: "test" }));
      const create = () => emailSdkMailer({ from: "help@acme.test", client });

      expect(create).toThrow(/custom headers .* reply-to/);
      expect(create).toThrow(SUPPORTED_ADAPTERS.join(", "));
    });
  });

  it("requires from", () => {
    expect(() =>
      emailSdkMailer({ from: "", client: realClient(memoryAdapter()) }),
    ).toThrow(TypeError);
  });

  it("requires a client", () => {
    expect(() => emailSdkMailer({ from: "help@acme.test" } as never)).toThrow(
      TypeError,
    );
  });
});
