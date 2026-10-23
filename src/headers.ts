import { PermanentMailError } from "./errors";

// Set by the mailer or the provider. Most provider SDKs reject them in
// `headers` too; checking here first keeps the error the same whatever client
// is behind the adapter.
const RESERVED_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "return-path",
  "sender",
]);

// RFC 5322 field-name: printable ASCII (33-126) except ":".
const BAD_NAME_CHAR = /[^!-9;-~]/u;
// RFC 5322 field-body, unfolded: printable ASCII (VCHAR) and WSP (space,
// tab). So no CR or LF (and no folding), no other control character, no DEL
// and no non-ASCII: a non-ASCII value has to be RFC 2047 encoded first.
const BAD_VALUE_CHAR = /[^\t -~]/u;

const codePoint = (char: string) =>
  `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Throws a {@link PermanentMailError} unless every header name is printable
 * ASCII without `:` and every value is printable ASCII, spaces and tabs on
 * one line. A send with any other header can never succeed, and checking here
 * makes every adapter fail the same way whatever the provider does with it.
 */
export function checkHeaders(
  headers: Readonly<Record<string, unknown>> | undefined,
): void {
  if (!headers) return;
  for (const [name, value] of Object.entries(headers)) {
    if (name === "") {
      throw new PermanentMailError("A header name can't be empty");
    }
    const badName = BAD_NAME_CHAR.exec(name)?.[0];
    if (badName !== undefined) {
      throw new PermanentMailError(
        `Header name ${JSON.stringify(name)} has ${codePoint(badName)}: ` +
          "names are printable ASCII without ':'",
      );
    }
    if (typeof value !== "string") {
      throw new PermanentMailError(
        `Header ${JSON.stringify(name)} must have a string value`,
      );
    }
    const badValue = BAD_VALUE_CHAR.exec(value)?.[0];
    if (badValue !== undefined) {
      throw new PermanentMailError(
        `Header ${JSON.stringify(name)} has ${codePoint(badValue)} in its value: ` +
          "values are printable ASCII, spaces and tabs, on one line " +
          "(RFC 2047-encode anything else)",
      );
    }
  }
}

/**
 * A copy of `headers` for the provider, or `undefined` when there are none.
 * Throws a {@link PermanentMailError} for a reserved header or one that
 * {@link checkHeaders} rejects, so the send fails before the provider is
 * called.
 */
export function copyHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  checkHeaders(headers);
  const copy: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new PermanentMailError(
        `"${name}" is set by the mailer or the provider and can't be passed in headers` +
          (name.toLowerCase() === "reply-to" ? " (use `replyTo`)" : ""),
      );
    }
    copy[name] = value;
  }
  return Object.keys(copy).length > 0 ? copy : undefined;
}

// SES documents the encoding as required for a non-ASCII "friendly from" name
// (https://docs.aws.amazon.com/ses/latest/APIReference/API_SendEmail.html,
// `Source`: "you must encode the "friendly from" name using MIME encoded-word
// syntax"). SES in us-east-1 accepted an unencoded name in real sends and
// encoded it itself, but that isn't documented, so it isn't relied on.

// An RFC 5322 phrase: atext, the spaces between words, and quoted-strings. An
// ASCII display name that is one needs no (more) quotes.
const PHRASE = /^(?:[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ \t]|"(?:[^"\\]|\\.)*")*$/su;
// One quoted-string, with no unescaped `"` inside.
const QUOTED = /^"(?:[^"\\]|\\.)*"$/su;
// An RFC 2047 encoded-word, which quoting would stop readers decoding.
const ENCODED_WORD = /=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=/u;
// RFC 2047: an encoded-word is at most 75 characters. `=?UTF-8?B?` and `?=`
// leave 63 for base64, so 60 characters, which encode 45 bytes.
const MAX_WORD_BYTES = 45;

function encodeWords(text: string): string {
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length === 0) return;
    words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...chunk))}?=`);
    chunk = [];
  };
  // split between code points, so no character is cut across two words
  for (const char of text) {
    const bytes = encoder.encode(char);
    if (chunk.length + bytes.length > MAX_WORD_BYTES) flush();
    chunk.push(...bytes);
  }
  flush();
  return words.join(" ");
}

/**
 * `from` ready to send as a header value, as the SES v1 `SendEmail` reference
 * asks for `Source`: a display name with non-ASCII characters becomes RFC 2047
 * encoded-words (`=?UTF-8?B?...?= <help@acme.com>`), and an ASCII name with
 * characters that need quoting (`.`, `,`, `@`, ...) is quoted. An ASCII name
 * that already holds an encoded-word, the address, and a `from` without a
 * display name are left as they are.
 */
export function encodeFrom(from: string): string {
  const match = /^(.*)<([^<>]*)>\s*$/su.exec(from);
  let name = match?.[1]?.trim();
  if (!match || !name) return from;
  const address = match[2];
  const ascii = [...name].every((char) => char.charCodeAt(0) < 0x80);
  if (ascii && (PHRASE.test(name) || ENCODED_WORD.test(name))) return from;
  if (QUOTED.test(name)) name = name.slice(1, -1).replace(/\\(.)/gsu, "$1");
  if (!ascii) return `${encodeWords(name)} <${address}>`;
  return `"${name.replace(/[\\"]/gu, "\\$&")}" <${address}>`;
}
