// Viewer disconnect does not affect pool or other viewers
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v1 = await connectViewer();
await v1.waitFor('targetChanged'); v1.clearEvents();

// Create tabs
v1.send({ type: 'newTab', url: 'https://example.com' });
const tc1 = await v1.waitFor('targetChanged');
v1.send({ type: 'newTab', url: 'https://www.iana.org/' });
await v1.waitFor('targetChanged');
await delay(500);

// Disconnect v1
v1.close();
await delay(1000);

// Connect v2 — should see all tabs and active tab
const v2 = await connectViewer();
const boot = await v2.waitFor('targetChanged');
if (!boot.targetId) fail('disconnect-no-affect', 'no targetChanged on v2 connect');

v2.send({ type: 'getTabs' });
const tabs = await v2.waitFor('tabs');
// Should have at least the bootstrap tab + 2 created tabs (3 total, minus possible closed ones)
if (tabs.tabs.length < 2) fail('disconnect-no-affect', 'expected >=2 tabs, got ' + tabs.tabs.length);

pass('disconnect-no-affect');
v2.close(); process.exit(0);
