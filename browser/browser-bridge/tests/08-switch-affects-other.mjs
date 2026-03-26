// Tab switch in one viewer broadcasts to the other
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v1 = await connectViewer();
await v1.waitFor('targetChanged'); v1.clearEvents();

// Create second tab
v1.send({ type: 'newTab', url: 'https://example.com' });
await v1.waitFor('targetChanged'); v1.clearEvents();

const v2 = await connectViewer();
await v2.waitFor('targetChanged'); v2.clearEvents();

// Get tabs to find one to switch to
v1.send({ type: 'getTabs' });
const tabs = await v1.waitFor('tabs');
const inactive = tabs.tabs.find(t => !t.active);
if (!inactive) fail('switch-affects-other', 'no inactive tab');

// Switch from v1
v1.send({ type: 'switchTab', targetId: inactive.id });

// v2 should receive targetChanged
try {
  const tc2 = await v2.waitFor('targetChanged', 5000);
  if (tc2.targetId === inactive.id) pass('switch-affects-other');
  else fail('switch-affects-other', 'v2 got different target: ' + tc2.targetId);
} catch {
  fail('switch-affects-other', 'v2 did not receive targetChanged');
}
v1.close(); v2.close(); process.exit(0);
