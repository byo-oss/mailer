import { describe, expect, it } from "vitest";
import {
  isPermanentMailError,
  type MailMessage,
  memoryMailer,
  PermanentMailError,
} from "./index";

const message = (): MailMessage => ({
  to: ["a@example.com", "b@example.com"],
  subject: "Hi",
  html: "<p>Hi</p>",
  text: "Hi",
  replyTo: "reply@example.com",
  headers: { "In-Reply-To": "<x@example.com>" },
});

describe("PermanentMailError", () => {
  it("is an Error with a name, a message and a cause", () => {
    const cause = new Error("bounce");
    const error = new PermanentMailError("bad address", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PermanentMailError");
    expect(error.message).toBe("bad address");
    expect(error.cause).toBe(cause);
  });
});

describe("isPermanentMailError", () => {
  it("accepts a PermanentMailError", () => {
    expect(isPermanentMailError(new PermanentMailError("x"))).toBe(true);
  });

  it("accepts a copy made by another instance of the package", () => {
    // what a second installed copy produces: same brand, different class
    class Other extends Error {
      constructor() {
        super("other");
        Object.defineProperty(this, Symbol.for("@byo-oss/mailer/permanent"), {
          value: true,
        });
      }
    }
    expect(isPermanentMailError(new Other())).toBe(true);
  });

  it("rejects ordinary errors and non-errors", () => {
    expect(isPermanentMailError(new Error("timeout"))).toBe(false);
    expect(
      isPermanentMailError(
        new Error("x", { cause: new PermanentMailError("y") }),
      ),
    ).toBe(false);
    expect(isPermanentMailError({ name: "PermanentMailError" })).toBe(false);
    expect(isPermanentMailError(undefined)).toBe(false);
    expect(isPermanentMailError(null)).toBe(false);
    expect(isPermanentMailError("PermanentMailError")).toBe(false);
  });
});

describe("memoryMailer", () => {
  it("records sent messages in order and returns an id", async () => {
    const mailer = memoryMailer();
    const first = await mailer.send(message());
    const second = await mailer.send({ ...message(), subject: "Two" });
    expect(first).toEqual({ id: "mem-1" });
    expect(second).toEqual({ id: "mem-2" });
    expect(mailer.sent.map((m) => m.subject)).toEqual(["Hi", "Two"]);
    expect(mailer.sent[0]).toEqual(message());
  });

  it("omits messageId unless asked", async () => {
    expect(await memoryMailer().send(message())).not.toHaveProperty(
      "messageId",
    );
    const result = await memoryMailer({ reportMessageId: true }).send(
      message(),
    );
    expect(result.messageId).toBe("<mem-1@memory.invalid>");
  });

  it("records a copy: later changes to the input don't show", async () => {
    const mailer = memoryMailer();
    const input = message();
    await mailer.send(input);
    input.subject = "changed";
    (input.to as string[]).push("c@example.com");
    if (input.headers) input.headers["In-Reply-To"] = "changed";
    expect(mailer.sent[0]).toEqual(message());
  });

  it("returns a copy: changing `sent` doesn't change the record", async () => {
    const mailer = memoryMailer();
    await mailer.send(message());
    const sent = mailer.sent;
    const [first] = sent;
    if (first) first.subject = "changed";
    sent.pop();
    expect(mailer.sent).toEqual([message()]);
  });

  it("accepts a frozen message", async () => {
    const mailer = memoryMailer();
    await expect(mailer.send(Object.freeze(message()))).resolves.toEqual({
      id: "mem-1",
    });
  });

  it("clear() forgets the recorded messages", async () => {
    const mailer = memoryMailer();
    await mailer.send(message());
    mailer.clear();
    expect(mailer.sent).toEqual([]);
  });

  it('fail: "retry" throws a plain error and records nothing', async () => {
    const mailer = memoryMailer({ fail: "retry" });
    const error = await mailer.send(message()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isPermanentMailError(error)).toBe(false);
    expect(mailer.sent).toEqual([]);
  });

  it('fail: "permanent" throws a PermanentMailError', async () => {
    const mailer = memoryMailer({ fail: "permanent" });
    const error = await mailer.send(message()).catch((e: unknown) => e);
    expect(isPermanentMailError(error)).toBe(true);
    expect(mailer.sent).toEqual([]);
  });

  it("can start and stop failing", async () => {
    const mailer = memoryMailer();
    mailer.fail = "retry";
    await expect(mailer.send(message())).rejects.toThrow();
    mailer.fail = undefined;
    await expect(mailer.send(message())).resolves.toEqual({ id: "mem-1" });
  });

  it("rejects a malformed header as permanent and records nothing, as the adapters do", async () => {
    const mailer = memoryMailer({ fail: "retry" });
    const error = await mailer
      .send({ ...message(), headers: { "X-Ticket": "1\r\nBcc: e@x.test" } })
      .catch((e: unknown) => e);
    expect(isPermanentMailError(error)).toBe(true);
    expect(mailer.sent).toEqual([]);
  });
});
