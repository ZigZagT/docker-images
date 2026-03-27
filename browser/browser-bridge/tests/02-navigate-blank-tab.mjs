// New blank tab + navigate does not revert on switch (3 rounds)
// Uses browserscan.net — the URL that triggered the original bug
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const TEST_URL = 'https://www.browserscan.net/bot-detection';
const v = await connectViewer();
await v.waitFor('targetChanged');
v.send({ type: 'getTabs' }); await v.waitFor('tabs');
v.clearEvents();

// Create blank tab
v.send({ type: 'newTab' });
await v.waitFor('targetChanged');
v.clearEvents();

// Create second tab for switching
v.send({ type: 'newTab', url: 'https://example.com' });
const otherTc = await v.waitFor('targetChanged');
const otherId = otherTc.targetId;

// Switch back to blank tab
v.send({ type: 'getTabs' });
const tabs0 = await v.waitFor('tabs');
const blankTab = tabs0.tabs.find(t => t.url === 'about:blank' || t.url === 'chrome://newtab/');
if (!blankTab) fail('navigate-blank-tab', 'no blank tab found');

v.send({ type: 'switchTab', targetId: blankTab.id });
await v.waitFor('targetChanged');
v.clearEvents();

for (let round = 1; round <= 3; round++) {
  v.send({ type: 'navigate', url: TEST_URL });
  await v.waitFor('navigated');
  await delay(3000); v.clearEvents();

  // Find the browserscan tab
  v.send({ type: 'getTabs' });
  const tabs = await v.waitFor('tabs');
  const navTab = tabs.tabs.find(t => t.url?.includes('browserscan'));
  if (!navTab) fail('navigate-blank-tab', `round ${round}: no browserscan tab in ${tabs.tabs.map(t=>t.url)}`);

  // Switch away
  v.send({ type: 'switchTab', targetId: otherId });
  await v.waitFor('targetChanged');
  await delay(2000); v.clearEvents();

  // Switch back
  v.send({ type: 'switchTab', targetId: navTab.id });
  await v.waitFor('targetChanged');
  await delay(3000);

  const list = await httpGet('http://127.0.0.1:18800/json/list');
  const actualUrl = list.find(t => t.id === navTab.id)?.url;
  const after = v.events.splice(0);
  const revert = after.find(m => m.type === 'navigated' && (m.url === 'about:blank' || m.url === 'chrome://newtab/'));

  if (revert) fail('navigate-blank-tab', `round ${round}: reverted to ${revert.url}`);
  if (actualUrl === 'about:blank' || actualUrl === 'chrome://newtab/') fail('navigate-blank-tab', `round ${round}: CDP reports ${actualUrl}`);
  console.log(`round ${round}: OK`);
}

pass('navigate-blank-tab');
v.close(); process.exit(0);
