// Full viewer lifecycle: new tab → navigate → switch away → switch back → verify URL.
// Reproduces the original bug where the URL reverted to about:blank after switching.
// Uses the standard connectViewer() approach (external WS, like production).
// Previous version embedded the viewer inside Chrome, which caused artificial
// background throttling — the viewer's JS event loop was throttled when the
// bridge activated other tabs, preventing WebSocket messages from being processed.
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const TEST_URL = 'https://www.browserscan.net/bot-detection';

const v = await connectViewer();
await v.waitFor('targetChanged');
v.clearEvents();

// Create a new blank tab (simulates clicking "+")
v.send({ type: 'newTab' });
const newTc = await v.waitFor('targetChanged');
const newTabId = newTc.targetId;
v.clearEvents();

// Navigate the new tab to browserscan (simulates typing URL + Enter)
v.send({ type: 'navigate', url: TEST_URL });
await v.waitFor('navigated');
await delay(3000);
v.clearEvents();

// Verify navigate landed on the correct tab
const midList = await httpGet('http://127.0.0.1:18800/json/list');
const midTab = midList.find(t => t.id === newTabId);
if (!midTab?.url?.includes('browserscan')) fail('browser-viewer-navigate', 'navigate did not land: ' + midTab?.url);

// Get another tab to switch to
v.send({ type: 'getTabs' });
const tabs = await v.waitFor('tabs');
const otherTab = tabs.tabs.find(t => !t.active);
if (!otherTab) fail('browser-viewer-navigate', 'no other tab to switch to');
v.clearEvents();

// Switch away
v.send({ type: 'switchTab', targetId: otherTab.id });
await v.waitFor('targetChanged');
await delay(2000);
v.clearEvents();

// Switch back to the browserscan tab
v.send({ type: 'switchTab', targetId: newTabId });
const backTc = await v.waitFor('targetChanged');
await delay(2000);

// Verify: the targetChanged event should have the browserscan URL
const list = await httpGet('http://127.0.0.1:18800/json/list');
const actualUrl = list.find(t => t.id === newTabId)?.url;

// Check for revert to about:blank
const revertEvents = v.events.filter(m => m.type === 'navigated' && (m.url === 'about:blank' || m.url === 'chrome://newtab/'));
if (revertEvents.length > 0) fail('browser-viewer-navigate', 'reverted to ' + revertEvents[0].url);
if (actualUrl === 'about:blank' || actualUrl === 'chrome://newtab/') fail('browser-viewer-navigate', 'CDP reports: ' + actualUrl);

// Verify the switch-back broadcast had the correct URL
if (!backTc.url?.includes('browserscan')) fail('browser-viewer-navigate', 'targetChanged URL wrong: ' + backTc.url);
if (!actualUrl?.includes('browserscan')) fail('browser-viewer-navigate', 'CDP URL wrong: ' + actualUrl);

pass('browser-viewer-navigate');
v.close(); process.exit(0);
