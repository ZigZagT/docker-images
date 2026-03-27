// Blank tab + navigate to heavy page does not revert on switch
// Tests issue #1 with a real-world URL instead of example.com
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const BING = 'https://www.bing.com/search?q=auto+repair+shop+software';
const v = await connectViewer();
await v.waitFor('targetChanged');
v.send({ type: 'getTabs' }); await v.waitFor('tabs');
v.clearEvents();

// "+" button flow: create blank tab
v.send({ type: 'newTab' });
await v.waitFor('targetChanged');
v.send({ type: 'getTabs' }); await v.waitFor('tabs');
v.clearEvents();

// Type URL in address bar
v.send({ type: 'navigate', url: BING });
// Bing does redirects — wait for navigated, then wait for full load
await v.waitFor('navigated');
await delay(8000);
v.clearEvents();

// Get the active tab's ID and URL
v.send({ type: 'getTabs' });
const tabs = await v.waitFor('tabs');
const active = tabs.tabs.find(t => t.active);
const other = tabs.tabs.find(t => !t.active);
if (!active) fail('navigate-heavy-page', 'no active tab');
const activeUrl = active.url;
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
const revertToBlank = navEvents.find(m => m.url === 'about:blank');

const list = await httpGet('http://127.0.0.1:18800/json/list');
const actualUrl = list.find(t => t.id === active.id)?.url;

if (revertToBlank) fail('navigate-heavy-page', 'reverted to about:blank');
if (actualUrl === 'about:blank') fail('navigate-heavy-page', 'CDP reports about:blank');
if (navEvents.length > 0) fail('navigate-heavy-page', 'page reloaded: ' + navEvents.map(m => m.url?.slice(0, 60)));
pass('navigate-heavy-page');
v.close(); process.exit(0);
