// Tab created with URL via newTab survives switch without reload
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

v.send({ type: 'newTab', url: 'https://example.com' });
await v.waitFor('targetChanged');
await delay(1500); v.clearEvents();

// Switch away
v.send({ type: 'getTabs' });
const tabs = await v.waitFor('tabs');
const other = tabs.tabs.find(t => !t.active);
const active = tabs.tabs.find(t => t.active);
v.clearEvents();

v.send({ type: 'switchTab', targetId: other.id });
await v.waitFor('targetChanged');
await delay(1000); v.clearEvents();

// Switch back
v.send({ type: 'switchTab', targetId: active.id });
await v.waitFor('targetChanged');
const after = await v.collectEvents(2000);
const nav = after.filter(m => m.type === 'navigated');
if (nav.length > 0) fail('newTab-url-survives', 'navigated events: ' + nav.map(m => m.url));
pass('newTab-url-survives');
v.close(); process.exit(0);
