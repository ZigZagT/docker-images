// Navigate sent immediately after newTab must land on the NEW tab.
// If the bridge hasn't finished switching to the new tab internally,
// the navigate could go to the old active tab instead.
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const v = await connectViewer();
const boot = await v.waitFor('targetChanged');
v.clearEvents();

// Create a new blank tab
v.send({ type: 'newTab' });
const newTc = await v.waitFor('targetChanged');
const newTabId = newTc.targetId;

// Navigate immediately (no extra delay)
v.send({ type: 'navigate', url: 'https://example.com' });
await v.waitFor('navigated');
await delay(2000);

// Verify: the NEW tab has the URL, not the boot tab
const list = await httpGet('http://127.0.0.1:18800/json/list');
const newTab = list.find(t => t.id === newTabId);
const bootTab = list.find(t => t.id === boot.targetId);

if (!newTab?.url?.includes('example.com')) {
  fail('navigate-after-newtab', 'new tab URL: ' + newTab?.url + ' (expected example.com)');
}
if (bootTab?.url?.includes('example.com')) {
  fail('navigate-after-newtab', 'navigate went to boot tab instead of new tab');
}

// Round 2: same pattern with a different URL to prove consistency
v.clearEvents();
v.send({ type: 'newTab' });
const newTc2 = await v.waitFor('targetChanged');
v.send({ type: 'navigate', url: 'https://www.iana.org/' });
await v.waitFor('navigated');
await delay(2000);

const list2 = await httpGet('http://127.0.0.1:18800/json/list');
const tab2 = list2.find(t => t.id === newTc2.targetId);
if (!tab2?.url?.includes('iana.org')) {
  fail('navigate-after-newtab', 'round 2: tab URL: ' + tab2?.url + ' (expected iana.org)');
}

pass('navigate-after-newtab');
v.close(); process.exit(0);
