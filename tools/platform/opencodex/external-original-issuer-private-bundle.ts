/** Public type boundary for the owner-registered issuer adapter.
 * Mock work has no OS-level peer authority and cannot consume live streams.
 */
export async function consumeOriginalIssuerSharedStream(
  ..._args: unknown[]
): Promise<never> {
  throw Error('private_issuer_adapter_not_available_in_public_lab');
}
