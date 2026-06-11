(function () {
  'use strict';

  /* v2.1 — DeepSeek brain agent: text-diff detection, multi-fallback selectors */

  function $(sel) {
    for (const s of sel) { const el = document.querySelector(s); if (el && el.offsetHeight > 0) return el; }
    return null;
  }
  function $$(sel) {
    for (const s of sel) { const els = document.querySelectorAll(s); const vis = Array.from(els).filter(e => e.offsetHeight > 0); if (vis.length) return vis; }
    return null;
  }

  function getInput() {
    let el = $(['textarea:not([disabled])', 'div[contenteditable="true"]', '[contenteditable]', 'input[type="text"]:not([disabled])']);
    if (!el) el = document.querySelector('textarea:not([disabled])');
    if (!el) el = document.querySelector('[contenteditable="true"]');
    return el;
  }

  function findSubmit() {
    let btn = $([
      'div.ds-button--primary',
      'button[type="submit"]',
      'div[role="button"]',
      'button:not([disabled])',
    ]);
    if (btn && btn.offsetHeight > 0) return btn;
    const input = getInput();
    if (input) {
      const area = input.closest('div, section') || input.parentElement;
      if (area) {
        const btns = area.querySelectorAll('button:not([disabled]), div[role="button"]:not([disabled])');
        for (const b of btns) { if (b.offsetHeight > 0) return b; }
      }
    }
    const all = document.querySelectorAll('button:not([disabled])');
    for (const b of all) { if (b.offsetHeight > 0) return b; }
    return null;
  }

  let lastInjected = '';
  let pageSnapshot = '';
  let navCount = 0;

  const UI_PATTERNS = [
    'AI-generated, for reference only', 'Instant', 'DeepThink', 'Search',
    'Skip to content', 'Chat history', 'New chat', 'Search chats',
    'Star Pro', 'Free', 'Upgrade', 'Sign up', 'Log in', 'Get started',
  ];

  function getPageText() {
    const els = document.body.querySelectorAll('div, p, section, article, span, pre, code');
    let texts = [];
    for (const el of els) {
      if (el.offsetHeight === 0) continue;
      if (el.closest('textarea') || el.closest('[class*="input"]') || el.closest('[class*="composer"]')) continue;
      const t = (el.innerText || '').trim();
      if (t.length > 20) texts.push(t);
    }
    return [...new Set(texts)].join('\n---\n');
  }

  function getNewContent() {
    const current = getPageText();
    if (!pageSnapshot) return current;
    const snapshotParts = pageSnapshot.split('\n---\n');
    const currentParts = current.split('\n---\n');
    const newParts = currentParts.filter(p => !snapshotParts.includes(p) && p.length > 30);
    const clean = newParts.filter(p => !UI_PATTERNS.some(ui => p.includes(ui)));
    return clean.join('\n\n');
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.action) {
        case 'ping': return { ok: true };

        case 'inject': {
          const el = getInput();
          if (!el) throw new Error('DeepSeek: input not found');
          lastInjected = msg.text;
          pageSnapshot = getPageText();
          el.focus();
          if (typeof el.value !== 'undefined') {
            el.value = msg.text;
            el.selectionStart = el.selectionEnd = msg.text.length;
          } else {
            el.innerHTML = '';
            const p = document.createElement('p'); p.textContent = msg.text; el.appendChild(p);
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
          return { ok: true };
        }

        case 'submit': {
          const btn = findSubmit();
          if (btn) { btn.click(); return { ok: true }; }
          const el = getInput();
          if (el) {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            return { ok: true };
          }
          throw new Error('DeepSeek: could not submit');
        }

        case 'read': {
          const text = getNewContent() || '';
          return { text };
        }

        case 'readDeep': {
          let best = '', bestLen = 0;
          const allEls = document.body.querySelectorAll('div, p, section, article');
          for (const el of allEls) {
            if (el.offsetHeight === 0) continue;
            if (el.closest('textarea') || el.closest('[class*="input"]') || el.closest('[class*="composer"]')) continue;
            const t = (el.innerText || '').trim();
            if (t.length > bestLen && t.length < 50000) {
              if (UI_PATTERNS.some(ui => t.includes(ui)) && t.length < 500) continue;
              best = t; bestLen = t.length;
            }
          }
          return { text: best };
        }

        case 'checkLogin': {
          const hasLogin = [...document.querySelectorAll('a, button')].some(el => /log in|sign in|sign up|register/i.test(el.innerText));
          return { loggedIn: !hasLogin };
        }

        default: throw new Error('Unknown: ' + msg.action);
      }
    })()
      .then(sendResponse)
      .catch(err => { console.error('[DS]', err); sendResponse({ error: err.message }); });
    return true;
  });

  console.log('[DS] v2.1 — Brain agent ready');
})();

