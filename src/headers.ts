import { PermanentMailError } from "./index";

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

/**
 * A copy of `headers` for the provider, or `undefined` when there are none.
 * Throws a {@link PermanentMailError} for a reserved header, so the send fails
 * before the provider is called.
 */
export function copyHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
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
