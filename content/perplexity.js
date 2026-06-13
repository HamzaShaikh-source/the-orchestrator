(function () {
  'use strict';

  const S = {
    input: ['#ask-input', 'div[contenteditable="true"]#ask-input', 'div[contenteditable="true"]', 'textarea'],
    submit: ['button[aria-label="Submit"]', 'button:not([disabled])[aria-label*="Submit"]'],
    response: ['.prose', '.markdown', '[data-message-content]', '.answer-body'],
  };

  function $(sel) {
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function $$(sel) {
    for (const s of sel) {
      const els = document.querySelectorAll(s);
      if (els.length) return els;
    }
    return null;
  }

  let lastInjected = '';
  let baselineCount = 0;

  const PLACEHOLDER_RE = /^(thinking|searching|generating|loading|researching)/i;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.action) {
        case 'ping': return { ok: true };
        case 'inject': {
          const el = await waitForInput();
          if (!el) throw new Error('Perplexity: input not found');
          baselineCount = ($$(S.response)?.length || 0);
          lastInjected = msg.text || '';
          el.focus();
          el.innerText = msg.text;
          el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: msg.text }));
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: msg.text }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          console.log('[Perplexity] Injected:', msg.text.slice(0, 60));
          return { ok: true };
        }
        case 'submit': {
          const btn = await waitForSubmit();
          if (btn) {
            btn.click();
            console.log('[Perplexity] Clicked submit button');
            return { ok: true };
          }
          const el = $(S.input);
          if (!el) throw new Error('Perplexity: input not found');
          el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13, cancelable: true }));
          console.log('[Perplexity] Dispatched Enter key');
          return { ok: true };
        }
        case 'read': {
          return { text: readResponse() || '' };
        }
        case 'readDeep': {
          let best='', bestLen=0;
          const proseEls = document.querySelectorAll('.prose, [data-message-content], span[data-message-content]');
          for (const el of proseEls) {
            const t = (el.innerText || '').trim();
            if (t.length > bestLen && t.length < 50000) { best = t; bestLen = t.length; }
          }
          if (!best) {
            const all=document.body.querySelectorAll('div,p,section,article');
            for(const el of all){if(el.offsetHeight===0)continue;if(el.closest('textarea')||el.closest('[class*="input"]'))continue;const t=(el.innerText||'').trim();if(t.length>bestLen&&t.length<50000){best=t;bestLen=t.length;}}
          }
          return {text: best};
        }
        case 'reset': {
          baselineCount = ($$(S.response)?.length || 0);
          lastInjected = '';
          return { ok: true };
        }
        case 'checkLogin': {
          const loginKeywords = ['log in', 'sign in', 'sign up', 'register'];
          const allLinks = document.querySelectorAll('a, button, [role="button"]');
          for (const el of allLinks) {
            const t = (el.textContent || '').toLowerCase().trim();
            if (loginKeywords.some(kw => t.includes(kw))) return { loggedIn: false };
          }
          return { loggedIn: true };
        }
        case 'isGenerating': {
          const allBtns = document.querySelectorAll('button, [role="button"]');
          for (const btn of allBtns) {
            if (btn.offsetHeight === 0) continue;
            const t = (btn.textContent || '').toLowerCase();
            if (t.includes('stop') || (btn.ariaLabel || '').toLowerCase().includes('stop')) return { generating: true };
          }
          return { generating: false };
        }
        default:
          throw new Error('Unknown action: ' + msg.action);
      }
    })()
      .then(sendResponse)
      .catch((err) => { console.error('[Perplexity]', err); sendResponse({ error: err.message }); });
    return true;
  });

  async function waitForInput(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = $(S.input);
      if (el) return el;
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }

  async function waitForSubmit(timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const btn = $(S.submit);
      if (btn && !btn.disabled && btn.offsetHeight > 0) return btn;
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }

  function readResponse() {
    const els = $$(S.response);
    if (!els) return '';
    for (let i = els.length - 1; i >= 0; i--) {
      if (i < baselineCount) break;
      const t = els[i].innerText?.trim();
      if (t && t.length > 10 && !isEcho(t)) return t;
    }
    return '';
  }

  function isEcho(text) {
    if (!lastInjected) return false;
    return text.includes(lastInjected) || lastInjected.includes(text);
  }

  console.log('[Perplexity] Content script loaded v2');
  document.documentElement.dataset.pxContentScript = 'v2';
})();
