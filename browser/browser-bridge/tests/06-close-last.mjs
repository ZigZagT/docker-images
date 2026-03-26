// Closing the last remaining tab creates a new blank tab
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v = await connectViewer();
const boot = await v.waitFor('targetChanged');
v.clearEvents();

// Close all tabs except the bootstrap tab by getting the list first
v.send({ type: 'getTabs' });
const tabs = await v.waitFor('tabs');
// Close non-active tabs
for (const t of tabs.tabs.filter(t => !t.active)) {
  v.send({ type: 'closeTab', targetId: t.id });
  await delay(500);
}
v.clearEvents();

// Now close the last tab — wait then check via getTabs
const activeId = tabs.tabs.find(t => t.active)?.id || boot.targetId;
v.send({ type: 'closeTab', targetId: activeId });
await delay(3000);
v.clearEvents();
v.send({ type: 'getTabs' });
const tabsAfter = await v.waitFor('tabs');
const newTab = tabsAfter.tabs.find(t => t.active);

if (newTab && (newTab.url === 'about:blank' || newTab.url === 'chrome://newtab/')) pass('close-last');
else if (!newTab) fail('close-last', 'no active tab after close');
else fail('close-last', 'expected about:blank, got: ' + newTab.url);
v.close(); process.exit(0);
