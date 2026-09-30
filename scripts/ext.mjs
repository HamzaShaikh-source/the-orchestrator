#!/usr/bin/env node
/* ext.mjs — print the load-unpacked path for the self-contained extension. */
import path from 'node:path';
import { ROOT } from './lib/proc.mjs';

const dir = path.join(ROOT, 'extension');
console.log('Self-contained Chrome extension (no server, no Python, no API keys):');
console.log('');
console.log('  1. open  chrome://extensions');
console.log('  2. turn on Developer mode');
console.log('  3. Load unpacked -> ' + dir);
console.log('  4. click the extension icon -> "Open dashboard"');
console.log('  5. log into chatgpt.com / gemini.google.com / perplexity.ai in this');
console.log('     browser, then hit Run. The pipeline executes in the service worker');
console.log('     using your existing session cookies.');
console.log('');
console.log('Works in any Chromium browser (Chrome, Brave, Edge, Vivaldi).');