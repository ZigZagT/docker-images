// Closing active tab switches to adjacent (next) tab
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

// Create tabs A, B, C
v.send({ type: 'newTab', url: 'https://example.com' });
const tcA = await v.waitFor('targetChanged');
v.send({ type: 'newTab', url: 'https://www.iana.org/' });
const tcB = await v.waitFor('targetChanged');
v.send({ type: 'newTab', url: 'https://httpbin.org/get' });
const tcC = await v.waitFor('targetChanged');
await delay(500);

// Switch to B
v.send({ type: 'switchTab', targetId: tcB.targetId });
await v.waitFor('targetChanged'); v.clearEvents();

// Close B — wait for tabCloseComplete then check active tab via getTabs
v.send({ type: 'closeTab', targetId: tcB.targetId });
await delay(3000);
v.clearEvents();
v.send({ type: 'getTabs' });
const tabs = await v.waitFor('tabs');
const active = tabs.tabs.find(t => t.active);

if (active?.id === tcC.targetId) pass('close-adjacent');
else if (active?.id === tcA.targetId) fail('close-adjacent', 'switched to A instead of C');
else fail('close-adjacent', 'active tab: ' + active?.id + ' url: ' + active?.url);
v.close(); process.exit(0);
