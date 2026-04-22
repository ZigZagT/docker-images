// switchTab must deliver targetChanged within 5 seconds, even after
// cross-origin navigation. If the bridge blocks internally (e.g. on
// screencast start), the user sees a frozen UI with no tab switch feedback.
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

// Create two tabs: one will be navigated cross-origin
v.send({ type: 'newTab', url: 'https://example.com' });
const tabA = await v.waitFor('targetChanged');
v.send({ type: 'newTab', url: 'about:blank' });
const tabB = await v.waitFor('targetChanged');
await delay(2000); v.clearEvents();

// Navigate tabB cross-origin
v.send({ type: 'navigate', url: 'https://www.browserscan.net/bot-detection' });
await v.waitFor('navigated');
await delay(3000); v.clearEvents();

// Switch to tabA
const t0 = Date.now();
v.send({ type: 'switchTab', targetId: tabA.targetId });
await v.waitFor('targetChanged');
const switchTime1 = Date.now() - t0;

// Switch back to tabB (the cross-origin-navigated tab)
v.clearEvents();
const t1 = Date.now();
v.send({ type: 'switchTab', targetId: tabB.targetId });
const tc = await v.waitFor('targetChanged');
const switchTime2 = Date.now() - t1;

if (switchTime1 > 5000) fail('switch-completes-promptly', 'switch to tabA took ' + switchTime1 + 'ms');
if (switchTime2 > 5000) fail('switch-completes-promptly', 'switch back to cross-origin tab took ' + switchTime2 + 'ms');
if (!tc.url?.includes('browserscan')) fail('switch-completes-promptly', 'wrong URL after switch back: ' + tc.url);

// Third round: switch away and back again to confirm stability
v.clearEvents();
v.send({ type: 'switchTab', targetId: tabA.targetId });
await v.waitFor('targetChanged');
v.clearEvents();
const t2 = Date.now();
v.send({ type: 'switchTab', targetId: tabB.targetId });
const tc2 = await v.waitFor('targetChanged');
const switchTime3 = Date.now() - t2;
if (switchTime3 > 5000) fail('switch-completes-promptly', 'third switch took ' + switchTime3 + 'ms');

pass('switch-completes-promptly');
v.close(); process.exit(0);
