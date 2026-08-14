/** True when a tool/bridge result is a user deny of a vendor override. */
export function isVendorDeclinedResult(text: string): boolean {
  return /^\s*USER DECLINED\b/i.test(text);
}

/** Plain instruction the calling bot must follow after the user denies a vendor override. */
export function vendorDeclinedForBot(vendorName: string): string {
  const name = vendorName.trim() || "that vendor";
  return (
    `USER DECLINED: The user said no to using ${name} in this chat. ` +
    `${name} stays blocked here for this instance. ` +
    `Tell them they declined ${name} for this chat, in one short sentence, then stop. ` +
    `Do not retry spawn or request_vendor. ` +
    `Offer a different callable vendor only if they still want the work done.`
  );
}
