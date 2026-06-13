(function() {
  'use strict';

  /* v2.1 — ChatGPT content script with text-diff fallback */

  const S = {
    input: ['#prompt-textarea', 'textarea', 'div[contenteditable="true"]', '[contenteditable]'],
    submit: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]:not([disabled])',
      'button.composer-submit-button-color:not([disabled])',
    ],
    response: [
      'div[data-message-author-role="assistant"]',
      '[data-turn="assistant"]',
      'article[data-testid*="conversation-turn"]',
    ],
  };

  const UI_PATTERNS = [
    'log in', 'sign in', 'sign up', 'register', 'upgrade', 'subscribe',
    'ChatGPT can make mistakes', 'content policy', 'terms of use',
  ];

  function $(sel) {
    for (const s of sel) { const el = document.querySelector(s); if (el && el.offsetHeight > 0) return el; }
    return null;
  }

  function findInput() {
    for (const s of S.input) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return document.querySelector('textarea:not([disabled])') || 
           document.querySelector('[contenteditable="true"]');
  }

  function findSubmitBtn() {
    for (const s of S.submit) {
      const el = document.querySelector(s);
      if (el && !el.disabled && el.offsetHeight > 0) return el;
    }
    const input = findInput();
    if (input) {
      const area = input.closest('[class*="composer"], [class*="input"], section, div') || input.parentElement;
      if (area) {
        const btns = area.querySelectorAll('button:not([disabled])');
        for (const b of btns) {
          if (b.offsetHeight > 0) {
            const label = (b.ariaLabel || b.textContent || '').toLowerCase();
            if (label.includes('send') || b.className.includes('submit')) return b;
          }
        }
        for (let i = btns.length - 1; i >= 0; i--) {
          if (btns[i].offsetHeight > 0) return btns[i];
        }
      }
    }
    return null;
  }

  function getResponses() {
    for (const s of S.response) {
      const els = document.querySelectorAll(s);
      if (els.length > 0) return els;
    }
    const candidates = document.querySelectorAll('[class*="message"], [class*="conversation"], article, [data-testid*="turn"]');
    if (candidates.length > 0) return candidates;
    return null;
  }

  let lastInjected = '';
  let baselineCount = 0;
  let pageSnapshot = '';

  /* Text-diff: capture all visible text for fallback detection */
  function getPageText() {
    const els = document.body.querySelectorAll('div, p, section, article, span, pre, code');
    let texts = [];
    for (const el of els) {
      if (el.offsetHeight === 0) continue;
      if (el.closest('textarea') || el.closest('[class*="input"]') || el.closest('[class*="composer"]')) continue;
      const t = (el.innerText || '').trim();
      if (t.length > 30) texts.push(t);
    }
    return [...new Set(texts)].join('\n---\n');
  }

  function getNewTextDiff() {
    const current = getPageText();
    if (!pageSnapshot) return '';
    const snapParts = pageSnapshot.split('\n---\n');
    const curParts = current.split('\n---\n');
    const newParts = curParts.filter(p => !snapParts.includes(p) && p.length > 50);
    const clean = newParts.filter(p => !UI_PATTERNS.some(ui => p.toLowerCase().includes(ui)));
    return clean.join('\n\n');
  }

  function dismissWelcome() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    const main = document.querySelector('main, [class*="composer"], [class*="conversation"]');
    if (main) main.click();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.action) {
        case 'ping': return { ok: true };
        case 'inject': {
          dismissWelcome();
          await new Promise(r => setTimeout(r, 500));
          const el = findInput();
          if (!el) throw new Error('ChatGPT: input not found');
          const responses = getResponses();
          baselineCount = responses ? responses.length : 0;
          pageSnapshot = getPageText(); /* Save snapshot for text-diff */
          lastInjected = msg.text;
          el.focus();
          if (el.tagName === 'TEXTAREA') {
            el.value = msg.text;
          } else {
            el.innerHTML = '';
            const p = document.createElement('p');
            p.textContent = msg.text;
            el.appendChild(p);
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
          return { ok: true };
        }
        case 'submit': {
          const btn = await waitForButton();
          if (btn) { btn.click(); return { ok: true }; }
          const el = findInput();
          if (el) {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
            return { ok: true };
          }
          throw new Error('ChatGPT: could not submit');
        }
        case 'read': {
          let text = '';
          /* Primary: response element detection */
          const responses = getResponses();
          if (responses) {
            for (let i = responses.length - 1; i >= baselineCount; i--) {
              if (i < 0) break;
              const t = responses[i]?.innerText?.trim();
              if (!t || t.length < 5 || t === 'Edit' || t === 'edit') {
                const img = responses[i]?.querySelector('img[alt*="Generated"]');
                if (img) { text = img.getAttribute('alt') || ''; break; }
                continue;
              }
              if (t && !t.includes(lastInjected)) { text = t; break; }
            }
          }
          /* Fallback: text-diff if primary failed */
          if (!text || text.length < 20) {
            const diff = getNewTextDiff();
            if (diff.length > 20) text = diff;
          }
          return { text };
        }
        case 'readDeep': {
          let best = '', bestLen = 0;
          const assisMessages = document.querySelectorAll('div[data-message-author-role="assistant"]');
          for (const msg of assisMessages) {
            const article = msg.closest('article');
            if (article) {
              const t = (article.innerText || '').trim();
              if (t.length > 20) { best = t; bestLen = t.length; break; }
            }
          }
          if (!best) {
            const allEls = document.body.querySelectorAll('div, p, section, article');
            for (const el of allEls) {
              if (el.offsetHeight === 0) continue;
              if (el.closest('textarea') || el.closest('[class*="input"]') || el.closest('[class*="composer"]')) continue;
              const t = (el.innerText || '').trim();
              if (t.length > bestLen && t.length < 50000) {
                if (UI_PATTERNS.some(ui => t.toLowerCase().includes(ui)) && t.length < 500) continue;
                best = t; bestLen = t.length;
              }
            }
          }
          return { text: best };
        }
        case 'reset': {
          pageSnapshot = getPageText();
          const responses = getResponses();
          baselineCount = responses ? responses.length : 0;
          lastInjected = '';
          return { ok: true };
        }
        case 'checkLogin': {
          const hasLoginEl = [...document.querySelectorAll('a, button')].some(el => /log in|sign in|sign up/i.test(el.innerText));
          if (hasLoginEl) return { loggedIn: false };
          const avatar = document.querySelector('[data-testid*="user-avatar"], img[alt*="avatar"], [class*="avatar"], [data-testid*="profile"]');
          if (avatar) return { loggedIn: true };
          return { loggedIn: true };
        }
        default:
          throw new Error('Unknown: ' + msg.action);
      }
    })()
      .then(sendResponse)
      .catch(err => { console.error('[GPT]', err); sendResponse({ error: err.message }); });
    return true;
  });

  async function waitForButton(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const btn = findSubmitBtn();
      if (btn) return btn;
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }
})();
