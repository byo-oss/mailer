import { describe, expect, it } from "vitest";
import { checkHeaders, copyHeaders, encodeFrom } from "./headers";
import { isPermanentMailError } from "./index";

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

// RFC 2047 B encoding back to text, to check what a reader would see
function decodeWords(header: string): string {
  return header
    .split(" ")
    .map((word) => {
      const base64 = /^=\?UTF-8\?B\?(.*)\?=$/u.exec(word)?.[1];
      if (base64 === undefined) throw new Error(`not an encoded-word: ${word}`);
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    })
    .join("");
}

describe("checkHeaders", () => {
  it.each([
    ["In-Reply-To", "<a1@example.com>"],
    ["References", "<a0@example.com> <a1@example.com>"],
    ["List-Unsubscribe", "<https://acme.test/u?t=1>, <mailto:u@acme.test>"],
    ["X-Tab", "a\tb"],
    ["X-Empty", ""],
    ["X-Encoded", "=?UTF-8?B?Q2Fmw6k=?="],
    ["!#$%&'*+-.^_`|~0", "every printable ASCII name character but :"],
  ])("accepts %s: %s", (name, value) => {
    expect(() => checkHeaders({ [name]: value })).not.toThrow();
  });

  it("accepts no headers", () => {
    expect(() => checkHeaders(undefined)).not.toThrow();
    expect(() => checkHeaders({})).not.toThrow();
  });

  it.each([
    ["an empty name", "", "1", /can't be empty/],
    ["a space in the name", "X Ticket", "1", /"X Ticket" has U\+0020/],
    ["a colon in the name", "X-Ticket:", "1", /"X-Ticket:" has U\+003A/],
    ["a tab in the name", "X\tTicket", "1", /U\+0009/],
    ["a non-ASCII name", "X-Tické", "1", /U\+00E9/],
    ["CRLF in the value", "X-Ticket", "1\r\nBcc: e@x.test", /U\+000D/],
    ["LF in the value", "X-Ticket", "1\nBcc: e@x.test", /U\+000A/],
    ["a folded value", "X-Ticket", "1\r\n 2", /U\+000D/],
    ["NUL in the value", "X-Ticket", "1\u0000", /U\+0000/],
    ["ESC in the value", "X-Ticket", "1\u001b[0m", /U\+001B/],
    ["DEL in the value", "X-Ticket", "1\u007f", /U\+007F/],
    ["a C1 control in the value", "X-Ticket", "1\u0085", /U\+0085/],
    ["non-ASCII text in the value", "X-Ticket", "Café", /U\+00E9/],
    ["an emoji in the value", "X-Ticket", "hi 👋", /U\+1F44B/],
  ])("rejects %s as permanent", (_, name, value, message) => {
    const error = thrown(() => checkHeaders({ [name]: value }));
    expect(isPermanentMailError(error)).toBe(true);
    expect((error as Error).message).toMatch(message);
  });

  it("doesn't echo the value in the error", () => {
    const error = thrown(() =>
      checkHeaders({ "X-Ticket": "secret-token\r\nBcc: e@x.test" }),
    );
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("rejects a value that isn't a string as permanent", () => {
    const error = thrown(() => checkHeaders({ "X-Ticket": 12 }));
    expect(isPermanentMailError(error)).toBe(true);
  });
});

describe("copyHeaders", () => {
  it("returns a copy, or undefined for none", () => {
    const headers = { "In-Reply-To": "<a1@example.com>" };
    const copy = copyHeaders(headers);
    expect(copy).toEqual(headers);
    expect(copy).not.toBe(headers);
    expect(copyHeaders(undefined)).toBeUndefined();
    expect(copyHeaders({})).toBeUndefined();
  });

  it("rejects a reserved header as permanent, pointing Reply-To at replyTo", () => {
    const error = thrown(() => copyHeaders({ "reply-to": "a@x.test" }));
    expect(isPermanentMailError(error)).toBe(true);
    expect((error as Error).message).toMatch(/replyTo/);
  });

  it("rejects a malformed header as permanent", () => {
    const error = thrown(() =>
      copyHeaders({ "X-Ticket": "1\r\nBcc: e@x.test" }),
    );
    expect(isPermanentMailError(error)).toBe(true);
  });
});

describe("encodeFrom", () => {
  it.each([
    "help@acme.test",
    "<help@acme.test>",
    "Acme <help@acme.test>",
    "Acme Support <help@acme.test>",
    "O'Brien & Co <help@acme.test>",
    '"Acme, Inc." <help@acme.test>',
    '"Acme \\"Help\\" Desk" <help@acme.test>',
    "=?UTF-8?B?Q2Fmw6k=?= <help@acme.test>",
    // quoting an encoded-word would stop readers decoding it
    "=?UTF-8?B?Q2Fmw6k=?=, Inc. <help@acme.test>",
    "Acme (=?UTF-8?Q?Caf=C3=A9?=) <help@acme.test>",
    // a phrase of several quoted-strings needs no more quotes
    '"Acme" "Help" <help@acme.test>',
    'Acme "Help" <help@acme.test>',
  ])("leaves %s unchanged", (from) => {
    expect(encodeFrom(from)).toBe(from);
  });

  it("encodes a non-ASCII display name and leaves the address alone", () => {
    expect(encodeFrom("Société Générale <help@acme.test>")).toBe(
      "=?UTF-8?B?U29jacOpdMOpIEfDqW7DqXJhbGU=?= <help@acme.test>",
    );
  });

  it("encodes the text inside the quotes of a quoted non-ASCII name", () => {
    const encoded = encodeFrom('"Café \\"Le Bon\\"" <help@acme.test>');
    const [words, address] = encoded.split(" <");
    expect(address).toBe("help@acme.test>");
    expect(decodeWords(words ?? "")).toBe('Café "Le Bon"');
  });

  it("encodes a phrase of several quoted-strings as written, not as one quoted-string", () => {
    const encoded = encodeFrom('"Café" "Bar" <help@acme.test>');
    const [words, address] = encoded.split(" <");
    expect(address).toBe("help@acme.test>");
    expect(decodeWords(words ?? "")).toBe('"Café" "Bar"');
  });

  it("splits a long name into encoded-words of at most 75 characters, between characters", () => {
    const name = `${"Société ".repeat(8)}👋🏽 ${"日本語".repeat(10)}`;
    const encoded = encodeFrom(`${name} <help@acme.test>`);
    const words = encoded.slice(0, encoded.lastIndexOf(" <"));
    expect(words.split(" ").length).toBeGreaterThan(1);
    for (const word of words.split(" ")) {
      expect(word.length).toBeLessThanOrEqual(75);
      // each word decodes on its own: no character is cut in two
      expect(decodeWords(word)).not.toContain("�");
    }
    expect(decodeWords(words)).toBe(name);
  });

  it.each([
    ["Acme, Inc. <help@acme.test>", '"Acme, Inc." <help@acme.test>'],
    ["J. Smith <help@acme.test>", '"J. Smith" <help@acme.test>'],
    ["help@acme <help@acme.test>", '"help@acme" <help@acme.test>'],
    ['Acme "Help <help@acme.test>', '"Acme \\"Help" <help@acme.test>'],
    ["a<b <help@acme.test>", '"a<b" <help@acme.test>'],
  ])("quotes the ASCII name in %s", (from, expected) => {
    expect(encodeFrom(from)).toBe(expected);
  });
});
