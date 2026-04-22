// Tab list updates must reach viewers WITHIN 200ms of the underlying
// CDP event. Previous design used a "tabsChanged" notification with a
// 500ms debounce that forced viewers to round-trip a getTabs request,
// causing visible "title updates with a noticeable delay" on:
//   - new tab opening
//   - in-page navigation (title changes)
//   - back/forward (title changes)
//
// Class: lazy notify+fetch instead of push-the-data.
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const v = await connectViewer();
await v.waitFor('targetChanged'); v.clearEvents();

// === Sub-test 1: new tab visible in tabs list within 200ms ===
const t0 = Date.now();
v.send({ type: 'newTab', url: 'https://example.com' });

let newTabSeen = -1;
const newTabId = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('targetChanged TO')), 5000);
  const ch = setInterval(() => {
    const tc = v.events.find(m => m.type === 'targetChanged');
    if (tc) { clearInterval(ch); clearTimeout(timer); resolve(tc.targetId); }
  }, 5);
});

// Wait for first tabs event that includes the new tab id
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('tabs containing new id TO')), 5000);
  const ch = setInterval(() => {
    const tabsEv = v.events.find(m => m.type === 'tabs' && m.tabs?.some(t => t.id === newTabId));
    if (tabsEv) { newTabSeen = Date.now() - t0; clearInterval(ch); clearTimeout(timer); resolve(); }
  }, 5);
});
v.clearEvents();

if (newTabSeen > 200) fail('tab-update-latency', 'new tab in tabs list took ' + newTabSeen + 'ms (>200ms)');

// === Sub-test 2: title update within 200ms after in-page navigate ===
v.send({ type: 'navigate', url: 'https://www.iana.org/' });
const navT0 = Date.now();

// Wait for navigated event first (we know the URL committed)
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('navigated TO')), 8000);
  const ch = setInterval(() => {
    if (v.events.find(m => m.type === 'navigated' && m.url?.includes('iana'))) {
      clearInterval(ch); clearTimeout(timer); resolve();
    }
  }, 5);
});

// Now the title should be reported in a tabs event quickly
const titleT0 = Date.now();
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('tabs with new title TO')), 5000);
  const ch = setInterval(() => {
    const tabsEv = v.events.find(m => m.type === 'tabs' && m.tabs?.some(t => t.id === newTabId && t.url?.includes('iana')));
    if (tabsEv) { clearInterval(ch); clearTimeout(timer); resolve(); }
  }, 5);
});
const titleLatency = Date.now() - titleT0;
v.clearEvents();

if (titleLatency > 200) fail('tab-update-latency', 'title update in tabs list took ' + titleLatency + 'ms (>200ms)');

pass('tab-update-latency (newTab=' + newTabSeen + 'ms, titleUpdate=' + titleLatency + 'ms)');
v.close(); process.exit(0);
