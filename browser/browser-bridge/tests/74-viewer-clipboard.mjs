// Run viewer keyboard/paste handlers in a VM to test platform-specific routing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const keyboard = html.slice(html.indexOf('// Keyboard\n'), html.indexOf('// URL bar\n'));
const modifiers = html.slice(html.indexOf('function modifiers(e)'), html.indexOf('function buttonName(b)'));
assert.ok(keyboard && modifiers, 'viewer handler sections exist');

function viewer(platform) {
  const handlers = {};
  const messages = [];
  const canvas = {};
  const document = { activeElement: canvas, addEventListener: (type, fn) => { handlers[type] = fn; } };
  vm.runInNewContext(modifiers + keyboard, {
    navigator: { platform }, document, canvas,
    send: message => messages.push(JSON.parse(JSON.stringify(message))),
    findBar: { classList: { contains: () => false } },
  });
  function key(type, key, modifier) {
    const event = {
      key, code: 'Key' + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0),
      metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
      [modifier]: true, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    handlers[type](event);
    return event;
  }
  return { handlers, messages, document, key };
}

for (const platform of ['Win32', 'MacIntel', 'Linux x86_64']) {
  const v = viewer(platform);
  const modifier = platform === 'MacIntel' ? 'metaKey' : 'ctrlKey';
  assert.equal(v.key('keydown', 'c', modifier).defaultPrevented, true, platform + ' copy intercepted');
  v.key('keyup', 'c', modifier);
  assert.deepEqual(v.messages.splice(0), [{ type: 'copy' }], platform + ' copy requested once');

  assert.equal(v.key('keydown', 'v', modifier).defaultPrevented, false, platform + ' native paste allowed');
  v.handlers.paste({ clipboardData: { getData: type => {
    assert.equal(type, 'text/plain');
    return 'clipboard text';
  } } });
  v.key('keyup', 'v', modifier);
  assert.deepEqual(v.messages.splice(0), [{ type: 'paste', text: 'clipboard text' }], platform + ' paste sent once without key/char duplication');

  // Control+A is forwarded as remote keyboard input.
  v.key('keydown', 'a', 'ctrlKey');
  v.key('keyup', 'a', 'ctrlKey');
  assert.deepEqual(v.messages.splice(0).map(m => [m.type, m.action, m.modifiers]),
    [['key', 'keyDown', 2], ['key', 'char', 2], ['key', 'keyUp', 2]]);

  // Local URL/search fields use browser clipboard handling.
  v.document.activeElement = {};
  assert.equal(v.key('keydown', 'c', modifier).defaultPrevented, false);
  assert.equal(v.key('keydown', 'v', modifier).defaultPrevented, false);
  v.handlers.paste({ clipboardData: { getData: () => 'local text' } });
  assert.deepEqual(v.messages, []);
}

// macOS Control+C/V is forwarded as remote keyboard input.
const mac = viewer('MacIntel');
for (const key of ['c', 'v']) {
  mac.key('keydown', key, 'ctrlKey');
  mac.key('keyup', key, 'ctrlKey');
  assert.deepEqual(mac.messages.splice(0).map(m => [m.type, m.action, m.key, m.modifiers]),
    [['key', 'keyDown', key, 2], ['key', 'char', key, 2], ['key', 'keyUp', key, 2]]);
}
console.log('PASS: viewer-clipboard (Windows/Linux Ctrl, Mac Command, Mac Control, local fields)');
