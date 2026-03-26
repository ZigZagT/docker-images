// New blank tab + navigate does not revert to about:blank on switch
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

// Create blank tab
v.send({ type: 'newTab' });
await v.waitFor('targetChanged'); v.clearEvents();

// Navigate to example.com
v.send({ type: 'navigate', url: 'https://example.com' });
await v.waitFor('navigated');
await delay(1000); v.clearEvents();

// Create second tab to switch to
v.send({ type: 'newTab', url: 'https://www.iana.org/' });
await v.waitFor('targetChanged'); v.clearEvents();

// Switch back to example.com tab
v.send({ type: 'getTabs' });
const tabs = await v.waitFor('tabs');
const exTab = tabs.tabs.find(t => t.url.includes('example.com'));
if (!exTab) fail('navigate-blank-tab', 'example.com tab not found in: ' + tabs.tabs.map(t => t.url));
v.clearEvents();

v.send({ type: 'switchTab', targetId: exTab.id });
await v.waitFor('targetChanged');
const after = await v.collectEvents(2000);
const revert = after.find(m => m.type === 'navigated' && m.url === 'about:blank');
if (revert) fail('navigate-blank-tab', 'reverted to about:blank');
pass('navigate-blank-tab');
v.close(); process.exit(0);
