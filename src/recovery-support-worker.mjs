#!/usr/bin/env node
import { recoveryBundle } from './tasks.mjs';

try {
  process.stdout.write(`${JSON.stringify(await recoveryBundle())}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    state: 'UNKNOWN_SUPPORT_COLLECTION_FAILED',
    generatedAt: new Date().toISOString(),
    error: error.message,
    components: [],
    attention: ['support-collection-failed'],
    privacy: { credentialsIncluded: false, rawOutputIncluded: false }
  })}\n`);
}
