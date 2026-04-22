// copyInternalState: verifies bridge exposes consistent internal state
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

// Create a tab so we have at least 2
v.send({ type: 'newTab', url: 'https://example.com' });
await v.waitFor('targetChanged');
await delay(1000); v.clearEvents();

v.send({ type: 'copyInternalState' });
const state = await v.waitFor('internalState');
const d = state.data;

if (!d) fail('internal-state', 'no data in internalState');
if (!d.browserConnected) fail('internal-state', 'browserConnected is false');
if (!d.activeTargetId) fail('internal-state', 'no activeTargetId');
if (!d.sessionPool[d.activeTargetId]) fail('internal-state', 'active target not in session pool');
if (!Array.isArray(d.cdpTargets)) fail('internal-state', 'cdpTargets not an array');

// knownTabs should have entries
const knownCount = Object.keys(d.knownTabs).length;
if (knownCount < 2) fail('internal-state', 'expected >=2 knownTabs, got ' + knownCount);

// activeTargetId should be in knownTabs
if (!(d.activeTargetId in d.knownTabs)) fail('internal-state', 'activeTargetId not in knownTabs');

// sessionPool entries should have sessionId
for (const [tid, entry] of Object.entries(d.sessionPool)) {
  if (!entry.sessionId) fail('internal-state', 'sessionPool entry ' + tid + ' has no sessionId');
}

pass('internal-state');
v.close(); process.exit(0);
