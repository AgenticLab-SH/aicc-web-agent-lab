// AICC adapter for the existing A1 broker. No new SSH identity or remote route.
import { spawn } from 'node:child_process';
import type { BrokerTransport } from './external-credential-owner';

export function createRegisteredA1BrokerTransport(): BrokerTransport {
  return { request(data: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn('ssh.exe', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        'skct-relay-micro', '/demo/owner/.local/bin/oracle-a1-connection exec -- python3 /demo/owner/.local/share/aicc-ocx-local/local-broker.py'],
      { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      const chunks: Buffer[] = [];
      let bytes = 0, settled = false;
      const finish = (value?: unknown, failed = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Broker exceptions and output can contain authentication diagnostics.
        if (failed) reject(Error('credential_owner_unavailable')); else resolve(value);
      };
      const timer = setTimeout(() => { child.kill(); finish(undefined, true); }, 45_000);
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 262_144) { child.kill(); finish(undefined, true); }
        else chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', () => {});
      child.once('error', () => finish(undefined, true));
      child.stdin.once('error', () => finish(undefined, true));
      child.once('close', code => {
        if (settled) return;
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish(value, code !== 0 || value?.ok !== true);
        } catch { finish(undefined, true); }
      });
      child.stdin.end(JSON.stringify(data));
    });
  } };
}
