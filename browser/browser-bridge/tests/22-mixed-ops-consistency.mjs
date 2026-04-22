// After a rapid sequence of create/navigate/switch/close operations,
// the bridge state must be consistent with Chrome's actual state.
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

// Create 3 tabs rapidly
const ids = [];
for (const url of ['https://example.com', 'https://www.iana.org/', 'https://httpbin.org/get']) {
  v.send({ type: 'newTab', url });
  const tc = await v.waitFor('targetChanged');
  ids.push(tc.targetId);
}
await delay(2000);

// Navigate tab[0] to a different URL
v.send({ type: 'switchTab', targetId: ids[0] });
await v.waitFor('targetChanged');
v.send({ type: 'navigate', url: 'https://www.browserscan.net/' });
await v.waitFor('navigated');
await delay(2000);

// Close tab[1]
v.send({ type: 'closeTab', targetId: ids[1] });
await delay(2000);

// Switch to tab[2]
v.clearEvents();
v.send({ type: 'switchTab', targetId: ids[2] });
await v.waitFor('targetChanged');

// Get bridge state via getTabs
v.clearEvents();
v.send({ type: 'getTabs' });
const tabsMsg = await v.waitFor('tabs');

// Get Chrome state
const list = await httpGet('http://127.0.0.1:18800/json/list');
const chromePages = list.filter(t => t.type === 'page');
const chromeIds = new Set(chromePages.map(t => t.id));

// Verify: bridge active tab matches
const bridgeActive = tabsMsg.tabs.find(t => t.active);
if (bridgeActive?.id !== ids[2]) {
  fail('mixed-ops-consistency', 'bridge active tab: ' + bridgeActive?.id + ' expected: ' + ids[2]);
}

// Verify: closed tab[1] is gone from both bridge and Chrome
const bridgeHasClosed = tabsMsg.tabs.some(t => t.id === ids[1]);
const chromeHasClosed = chromeIds.has(ids[1]);
if (bridgeHasClosed) fail('mixed-ops-consistency', 'closed tab still in bridge tabs');
if (chromeHasClosed) fail('mixed-ops-consistency', 'closed tab still in Chrome');

// Verify: tab[0] has the navigated URL in Chrome
const tab0Chrome = chromePages.find(t => t.id === ids[0]);
if (!tab0Chrome?.url?.includes('browserscan')) {
  fail('mixed-ops-consistency', 'tab[0] URL: ' + tab0Chrome?.url + ' expected browserscan');
}

// Verify: tab[2] exists in both
const tab2Bridge = tabsMsg.tabs.find(t => t.id === ids[2]);
const tab2Chrome = chromePages.find(t => t.id === ids[2]);
if (!tab2Bridge) fail('mixed-ops-consistency', 'tab[2] missing from bridge');
if (!tab2Chrome) fail('mixed-ops-consistency', 'tab[2] missing from Chrome');

pass('mixed-ops-consistency');
v.close(); process.exit(0);
