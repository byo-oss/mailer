// The host SES puts after the SES message id in the `Message-ID` header it
// writes, by the region that sent the message. SES always replaces the
// `Message-ID` a sender sets (https://docs.aws.amazon.com/ses/latest/dg/header-fields.html:
// "If you provide a Message-ID header, Amazon SES overrides the header with
// its own value"), but AWS doesn't document the value. us-east-1 is listed
// because real sends there were read back as `<SES message id>@email.amazonses.com`,
// from SES v1 and v2 simple sends and a raw send. Other regions are left out until a send
// there is read back the same way: a guessed `Message-ID` would make replies
// thread to a message that doesn't exist.
const MESSAGE_ID_HOSTS: Readonly<Record<string, string>> = Object.freeze({
  "us-east-1": "email.amazonses.com",
});

/**
 * The `Message-ID` SES wrote for the message it accepted as `id` in `region`,
 * with angle brackets (`<id@email.amazonses.com>`), or `undefined` when the
 * region is unknown or its host isn't confirmed.
 */
export function sesMessageId(
  id: string,
  region: string | undefined,
): string | undefined {
  const host =
    region && Object.hasOwn(MESSAGE_ID_HOSTS, region)
      ? MESSAGE_ID_HOSTS[region]
      : undefined;
  return host ? `<${id}@${host}>` : undefined;
}

/**
 * The `id` to return when SES accepted a send but reported no message id:
 * `"ses:<random uuid>"`. Throwing instead would make the caller send the
 * message again.
 */
export function madeUpSesId(): string {
  return `ses:${globalThis.crypto.randomUUID()}`;
}
