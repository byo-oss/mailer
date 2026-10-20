import { describe, expect, it } from "vitest";
import { type Mailer, memoryMailer, PermanentMailError } from "./index";
import { mailMessage, testMailer } from "./testing";

testMailer(() => memoryMailer(), {
  failing: () => memoryMailer({ fail: "retry" }),
  permanentlyFailing: () => memoryMailer({ fail: "permanent" }),
});

testMailer(() => memoryMailer({ reportMessageId: true }), {
  failing: () => memoryMailer({ fail: "retry" }),
});

describe("testMailer helpers", () => {
  it("mailMessage applies overrides", () => {
    expect(mailMessage({ subject: "x" }).subject).toBe("x");
    expect(mailMessage().replyTo).toBeTruthy();
  });

  it("a mailer that mutates its input would fail the suite's freeze", async () => {
    const mutating: Mailer = {
      async send(message) {
        message.subject = "changed";
        return { id: "1" };
      },
    };
    const message = Object.freeze(mailMessage());
    await expect(mutating.send(message)).rejects.toThrow(TypeError);
  });

  it("PermanentMailError is not mistaken for a retryable failure", () => {
    expect(new PermanentMailError("x").permanent).toBe(true);
  });
});
