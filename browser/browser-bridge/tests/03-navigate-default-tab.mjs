// Navigate default tab does not revert on switch (3 rounds)
import { connectViewer, delay, httpGet, pass, fail } from './helpers.mjs';

const TEST_URL = 'https://www.browserscan.net/bot-detection';
const v = await connectViewer();
const boot = await v.waitFor('targetChanged');
v.clearEvents();

// Create second tab for switching
v.send({ type: 'newTab', url: 'https://example.com' });
const otherTc = await v.waitFor('targetChanged');
const otherId = otherTc.targetId;

// Switch back to default tab
v.send({ type: 'switchTab', targetId: boot.targetId });
await v.waitFor('targetChanged');
v.clearEvents();

for (let round = 1; round <= 3; round++) {
  v.send({ type: 'navigate', url: TEST_URL });
  await v.waitFor('navigated');
  await delay(3000); v.clearEvents();

  v.send({ type: 'getTabs' });
  const tabs = await v.waitFor('tabs');
  const navTab = tabs.tabs.find(t => t.url?.includes('browserscan'));
  if (!navTab) fail('navigate-default-tab', `round ${round}: no browserscan tab`);

  v.send({ type: 'switchTab', targetId: otherId });
  await v.waitFor('targetChanged');
  await delay(2000); v.clearEvents();

  v.send({ type: 'switchTab', targetId: navTab.id });
  await v.waitFor('targetChanged');
  await delay(3000);

  const list = await httpGet('http://127.0.0.1:18800/json/list');
  const actualUrl = list.find(t => t.id === navTab.id)?.url;
  const after = v.events.splice(0);
  const revert = after.find(m => m.type === 'navigated' && (m.url === 'chrome://newtab/' || m.url === 'about:blank'));

  if (revert) fail('navigate-default-tab', `round ${round}: reverted to ${revert.url}`);
  if (actualUrl === 'chrome://newtab/' || actualUrl === 'about:blank') fail('navigate-default-tab', `round ${round}: CDP reports ${actualUrl}`);
  console.log(`round ${round}: OK`);
}

pass('navigate-default-tab');
v.close(); process.exit(0);
