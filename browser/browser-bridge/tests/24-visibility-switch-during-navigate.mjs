// Simulates the visibilitychange race: while a cross-origin navigate is
// in flight, a resumeScreencast arrives (as if the browser tab regained
// focus). The navigate must still land on the correct tab.
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

// Create blank tab and get its ID
v.send({ type: 'newTab' });
const tc = await v.waitFor('targetChanged');
const tabId = tc.targetId;
v.clearEvents();

// Send navigate AND resumeScreencast near-simultaneously
v.send({ type: 'navigate', url: 'https://example.com' });
v.send({ type: 'resumeScreencast' });

// Wait for page to load
await delay(5000);

// Check: the tab should be at example.com
const list = await httpGet('http://127.0.0.1:18800/json/list');
const tab = list.find(t => t.id === tabId);

if (!tab) fail('visibility-switch-during-navigate', 'tab gone');
if (tab.url === 'about:blank') fail('visibility-switch-during-navigate', 'URL reverted to about:blank');
if (!tab.url?.includes('example.com')) fail('visibility-switch-during-navigate', 'URL wrong: ' + tab.url);

pass('visibility-switch-during-navigate');
v.close(); process.exit(0);
