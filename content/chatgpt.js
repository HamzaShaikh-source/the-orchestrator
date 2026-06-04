(function() {
  'use strict';

  /* Auto-healing selectors for ChatGPT */
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

  function findInput() {
    for (const s of S.input) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    /* Auto-heal: find textarea or contenteditable anywhere */
    return document.querySelector('textarea:not([disabled])') || 
           document.querySelector('[contenteditable="true"]');
  }

  function findSubmitBtn() {
    for (const s of S.submit) {
      const el = document.querySelector(s);
      if (el && !el.disabled && el.offsetHeight > 0) return el;
    }
    /* Auto-heal: find send-like button near input */
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
        /* Last button in the area */
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
    /* Auto-heal: find any message-like elements */
    const candidates = document.querySelectorAll('[class*="message"], [class*="conversation"], article, [data-testid*="turn"]');
    if (candidates.length > 0) return candidates;
    return null;
  }

  let lastInjected = '';
  let baselineCount = 0;

  function dismissWelcome() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
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
          if (!btn) throw new Error('ChatGPT: submit button not found');
          btn.click();
          return { ok: true };
        }
        case 'read': {
          let text = '';
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
          return { text };
        }
        case 'checkLogin': {
          const hasLogin = [...document.querySelectorAll('a, button')].some(el => /log in|sign in|sign up/i.test(el.innerText));
          return { loggedIn: !hasLogin };
        }
        default:
          throw new Error('Unknown action: ' + msg.action);
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
