// duplicateTab creates a new tab with the same URL as the active tab
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

// Navigate to a known URL
v.send({ type: 'navigate', url: 'https://example.com' });
await v.waitFor('navigated');
await delay(2000); v.clearEvents();

// Duplicate the active tab
v.send({ type: 'duplicateTab' });
const tc = await v.waitFor('targetChanged');
await delay(2000);

// Verify the new tab has the same URL
const list = await httpGet('http://127.0.0.1:18800/json/list');
const dupTab = list.find(t => t.id === tc.targetId);
if (!dupTab) fail('duplicate-tab', 'duplicated tab not found in target list');
if (!dupTab.url?.includes('example.com')) fail('duplicate-tab', 'expected example.com, got: ' + dupTab.url);

// Verify we now have at least 2 tabs with example.com
const exTabs = list.filter(t => t.type === 'page' && t.url?.includes('example.com'));
if (exTabs.length < 2) fail('duplicate-tab', 'expected >=2 example.com tabs, got ' + exTabs.length);

pass('duplicate-tab');
v.close(); process.exit(0);
