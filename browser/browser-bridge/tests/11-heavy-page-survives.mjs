// Heavy page (Bing search) survives tab switch without reload
// This is the exact URL the user reproduced issue #2 with
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const BING = 'https://www.bing.com/search?q=auto+repair+shop+software';
const v = await connectViewer();
await v.waitFor('targetChanged');
v.send({ type: 'getTabs' }); await v.waitFor('tabs');
v.clearEvents();

// Create tab with heavy URL
v.send({ type: 'newTab', url: BING });
await v.waitFor('targetChanged');
v.send({ type: 'getTabs' }); await v.waitFor('tabs');

// Wait for full page load (Bing has redirects, JS, ads)
await delay(8000);
v.clearEvents();

// Get tab IDs
v.send({ type: 'getTabs' });
const tabs = await v.waitFor('tabs');
const other = tabs.tabs.find(t => !t.active);
const active = tabs.tabs.find(t => t.active);
if (!active) fail('heavy-page-survives', 'no active tab');
v.clearEvents();

// Switch away
v.send({ type: 'switchTab', targetId: other.id });
await v.waitFor('targetChanged');
v.send({ type: 'getTabs' }); await v.waitFor('tabs');
await delay(3000);
v.clearEvents();

// Switch back
v.send({ type: 'switchTab', targetId: active.id });
await v.waitFor('targetChanged');
v.send({ type: 'getTabs' }); await v.waitFor('tabs');
await delay(3000);

const after = v.events.splice(0);
const navEvents = after.filter(m => m.type === 'navigated');
const loadEvents = after.filter(m => m.type === 'loading');

const list = await httpGet('http://127.0.0.1:18800/json/list');
const actualUrl = list.find(t => t.id === active.id)?.url;

if (navEvents.length > 0) fail('heavy-page-survives', 'navigated events (page reloaded): ' + navEvents.map(m => m.url?.slice(0, 60)));
if (loadEvents.length > 0) fail('heavy-page-survives', 'loading events fired (page reloaded)');
if (actualUrl === 'about:blank') fail('heavy-page-survives', 'CDP reports about:blank');
pass('heavy-page-survives');
v.close(); process.exit(0);
