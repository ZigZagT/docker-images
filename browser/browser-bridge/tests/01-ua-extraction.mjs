// UA string extracted at build time, "Headless" stripped
import fs from 'fs';
import { pass, fail } from './helpers.mjs';

const ua = fs.readFileSync('/usr/local/etc/chrome-ua', 'utf8').trim();
if (!ua.startsWith('Mozilla/5.0')) fail('ua-extraction', 'does not start with Mozilla/5.0: ' + ua);
if (ua.includes('Headless')) fail('ua-extraction', 'contains Headless: ' + ua);
pass('ua-extraction');
