import { WrapsEmail } from "@wraps.dev/email";
import { describe, expect, it } from "vitest";
import { mailMessage } from "./testing";
import { wrapsMailer } from "./wraps";

// The real @wraps.dev/email over a fake SES client (no mock), to check what it
// puts on the wire. Pins the peer floor: before 0.15.1 a non-ASCII `Subject` was
// written to the raw MIME message (the path taken when `headers` are set) as raw
// UTF-8 bytes instead of an RFC 2047 encoded-word.
function recordingSes() {
  const sent: { Data: Uint8Array }[] = [];
  const client = {
    config: { region: async () => "us-east-1" },
    send: async (command: { input: { RawMessage?: { Data: Uint8Array } } }) => {
      if (command.input.RawMessage) sent.push(command.input.RawMessage);
      return { MessageId: "0000-sdk-test", $metadata: { requestId: "r" } };
    },
    destroy() {},
  };
  return { sent, client };
}

const topHeaders = (raw: Uint8Array) => {
  const text = Buffer.from(raw).toString("latin1");
  return text.slice(0, text.indexOf("\r\n\r\n")).replace(/\r\n[ \t]+/g, " ");
};

describe("wrapsMailer over the real @wraps.dev/email", () => {
  it("sends a non-ASCII subject as an RFC 2047 encoded-word when headers are set", async () => {
    const { sent, client } = recordingSes();
    const mailer = wrapsMailer({
      from: "Support <help@example.com>",
      // biome-ignore lint/suspicious/noExplicitAny: a fake SES client
      client: new WrapsEmail({ client: client as any }),
    });

    await mailer.send(
      mailMessage({
        subject: "Re: Ünïcode — café",
        headers: { "In-Reply-To": "<a1@example.com>" },
      }),
    );

    expect(sent).toHaveLength(1);
    const headers = topHeaders((sent[0] as { Data: Uint8Array }).Data);
    const encoded = Buffer.from("Re: Ünïcode — café").toString("base64");
    expect(headers).toContain(`Subject: =?UTF-8?B?${encoded}?=`);
    // no raw 8-bit byte anywhere in the top-level headers
    expect(
      [...Buffer.from(headers, "latin1")].every((byte) => byte < 0x80),
    ).toBe(true);
  });
});
