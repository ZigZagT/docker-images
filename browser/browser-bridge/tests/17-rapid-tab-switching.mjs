// Rapid tab switching: operation queue must serialize without deadlock
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

// Create 3 tabs
const ids = [];
for (const url of ['https://example.com', 'https://www.iana.org/', 'https://httpbin.org/get']) {
  v.clearEvents();
  v.send({ type: 'newTab', url });
  const tc = await v.waitFor('targetChanged');
  ids.push(tc.targetId);
}
await delay(2000); v.clearEvents();

// Rapid-fire: switch all 3 tabs without waiting
for (const id of ids) {
  v.send({ type: 'switchTab', targetId: id });
}

// Wait for the queue to drain — bridge serializes all 3 switches
await delay(10000);
v.clearEvents();

// Final state: last switch should be ids[2]
v.send({ type: 'getTabs' });
const tabs = await v.waitFor('tabs');
const active = tabs.tabs.find(t => t.active);
if (active?.id !== ids[2]) fail('rapid-tab-switching', 'expected last tab active, got ' + active?.id + ' url: ' + active?.url);

pass('rapid-tab-switching');
v.close(); process.exit(0);
