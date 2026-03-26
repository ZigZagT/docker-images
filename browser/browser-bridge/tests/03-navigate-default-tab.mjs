// Navigate on default chrome://newtab/ tab does not revert on switch
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v = await connectViewer();
const boot = await v.waitFor('targetChanged');
const tabId = boot.targetId;
v.clearEvents();

// Navigate default tab
v.send({ type: 'navigate', url: 'https://example.com' });
await v.waitFor('navigated');
await delay(1000); v.clearEvents();

// Create second tab
v.send({ type: 'newTab', url: 'https://www.iana.org/' });
await v.waitFor('targetChanged'); v.clearEvents();

// Switch back
v.send({ type: 'getTabs' });
const tabs = await v.waitFor('tabs');
const exTab = tabs.tabs.find(t => t.url.includes('example.com'));
if (!exTab) fail('navigate-default-tab', 'example.com tab not found');
v.clearEvents();

v.send({ type: 'switchTab', targetId: exTab.id });
await v.waitFor('targetChanged');
const after = await v.collectEvents(2000);
const revert = after.find(m => m.type === 'navigated' && (m.url === 'chrome://newtab/' || m.url === 'about:blank'));
if (revert) fail('navigate-default-tab', 'reverted to ' + revert.url);
pass('navigate-default-tab');
v.close(); process.exit(0);
