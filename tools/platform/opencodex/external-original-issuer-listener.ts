// Runs inside the registered shared Bun lifecycle. Never spawns another OCX.
import type {consumeOriginalIssuerSharedStream} from './external-original-issuer-private-bundle';

type OwnerHost = Parameters<typeof consumeOriginalIssuerSharedStream>[0];

// Bun's public Socket API does not provide the Windows AF_UNIX kernel peer
// capability needed by this shipping acceptor. A protected directory, a ready
// frame, or an executable path cannot supply that authority. In particular,
// passing undefined as the expected runtime merely trusts the incoming hello.
//
// Keep the existing startup call fail-closed until its registered OS-owned
// launcher transfers authenticated peers and exact process lifetime authority.
// Do not add an optional callback/boolean/JSON proof that can assert trust.
// The private shared consumer and native retained-handle APIs remain available
// to their real authenticated embedders; they are not authorized by this stub.
export function startRegisteredOriginalIssuerListener(
  _host: OwnerHost, _socketPath: string,
): {stop(closeActiveConnections?: boolean): void} {
  throw Error('original_issuer_os_peer_authority_required');
}
