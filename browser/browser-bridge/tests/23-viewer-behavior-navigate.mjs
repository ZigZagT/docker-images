// Reproduces the real viewer's behavior during navigate → switch → switch back.
// The viewer does things the raw WebSocket tests skip:
// 1. Sends getTabs after every targetChanged (requestTabs in handler)
// 2. Runs a 3-second interval sending getTabs continuously
// 3. Sends switchTab(currentTargetId) on visibilitychange
// These create concurrent operations that can race with navigate/switch.
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged');
v.clearEvents();

// Simulate viewer's 3-second tab refresh interval
const refreshInterval = setInterval(() => {
  v.send({ type: 'getTabs' });
}, 3000);

// Simulate viewer's requestTabs-on-targetChanged behavior:
// intercept events and send getTabs for every targetChanged
const origEvents = v.events;
const targetChangedUrls = [];
const checkInterval = setInterval(() => {
  for (const ev of origEvents) {
    if (ev.type === 'targetChanged') {
      targetChangedUrls.push(ev.url);
      v.send({ type: 'getTabs' });
    }
  }
}, 50);

// Create new tab
v.send({ type: 'newTab' });
await v.waitFor('targetChanged');
const tcNew = targetChangedUrls[targetChangedUrls.length - 1];
v.clearEvents(); targetChangedUrls.length = 0;

// Get the new tab's ID
v.send({ type: 'getTabs' });
const tabs1 = await v.waitFor('tabs');
const activeTab = tabs1.tabs.find(t => t.active);
const otherTab = tabs1.tabs.find(t => !t.active);
if (!activeTab || !otherTab) fail('viewer-behavior-navigate', 'need 2 tabs');
v.clearEvents(); targetChangedUrls.length = 0;

// Navigate (like typing in URL bar + Enter)
v.send({ type: 'navigate', url: 'https://example.com' });
await v.waitFor('navigated');
await delay(3000);
v.clearEvents(); targetChangedUrls.length = 0;

// Simulate visibilitychange: send switchTab with current target
// (viewer does this when tab becomes visible again)
v.send({ type: 'switchTab', targetId: activeTab.id });
await delay(500);
v.clearEvents(); targetChangedUrls.length = 0;

// Switch to other tab
v.send({ type: 'switchTab', targetId: otherTab.id });
await v.waitFor('targetChanged');
v.clearEvents(); targetChangedUrls.length = 0;

// Simulate visibilitychange again
v.send({ type: 'switchTab', targetId: otherTab.id });
await delay(500);
v.clearEvents(); targetChangedUrls.length = 0;

// Switch back to original tab
v.send({ type: 'switchTab', targetId: activeTab.id });
const backTc = await v.waitFor('targetChanged');
await delay(1000);

// Stop intervals
clearInterval(refreshInterval);
clearInterval(checkInterval);

// Check: URL must be example.com, not about:blank
const list = await httpGet('http://127.0.0.1:18800/json/list');
const actualUrl = list.find(t => t.id === activeTab.id)?.url;

if (backTc.url === 'about:blank' || backTc.url === 'chrome://newtab/') {
  fail('viewer-behavior-navigate', 'targetChanged URL reverted: ' + backTc.url);
}
if (actualUrl === 'about:blank' || actualUrl === 'chrome://newtab/') {
  fail('viewer-behavior-navigate', 'CDP URL reverted: ' + actualUrl);
}
if (!backTc.url?.includes('example.com')) {
  fail('viewer-behavior-navigate', 'targetChanged URL wrong: ' + backTc.url);
}

// Check for any spurious navigated events to about:blank
const revertEvents = v.events.filter(m =>
  m.type === 'navigated' && (m.url === 'about:blank' || m.url === 'chrome://newtab/'));
if (revertEvents.length > 0) {
  fail('viewer-behavior-navigate', 'spurious navigated to ' + revertEvents[0].url);
}

pass('viewer-behavior-navigate');
v.close(); process.exit(0);
