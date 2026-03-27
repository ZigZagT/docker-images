// Tab created with URL via newTab survives switch without reload
// Verifies both event stream AND actual URL from Chrome's /json/list
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

v.send({ type: 'newTab', url: 'https://example.com' });
const tc = await v.waitFor('targetChanged');
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
await delay(3000);

const after = v.events.splice(0);
const nav = after.filter(m => m.type === 'navigated');

const list = await httpGet('http://127.0.0.1:18800/json/list');
const actualUrl = list.find(t => t.id === active.id)?.url;

if (nav.length > 0) fail('newTab-url-survives', 'navigated events: ' + nav.map(m => m.url));
if (!actualUrl?.includes('example.com')) fail('newTab-url-survives', 'expected example.com, CDP reports: ' + actualUrl);
pass('newTab-url-survives');
v.close(); process.exit(0);
