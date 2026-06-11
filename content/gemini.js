(function () {
  'use strict';

  const S = {
    input: ['div.ql-editor', 'div[contenteditable="true"]', '#mat-input-0'],
    submit: ['button[aria-label="Send message"]', 'button.send-button'],
    response: ['message-content', '.markdown-main-panel', '.model-response-content', '.message-content', '.conversation-turn'],
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

  const PLACEHOLDER_RE = /^(thinking|generating|typing|loading)/i;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.action) {
        case 'ping': return { ok: true };
        case 'inject': {
          const el = await waitForInput();
          if (!el) throw new Error('Gemini: input not found');
          baselineCount = ($$(S.response)?.length || 0);
          lastInjected = msg.text || '';
          el.focus();
          el.innerText = msg.text;
          el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: msg.text }));
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: msg.text }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
          console.log('[Gemini] Injected:', msg.text.slice(0, 60));
          return { ok: true };
        }
        case 'submit': {
          const btn = await findSubmitBtn();
          if (!btn) throw new Error('Gemini: could not find submit button');
          btn.click();
          console.log('[Gemini] Clicked submit');
          return { ok: true };
        }
        case 'read': {
          return { text: readResponse() || '' };
        }
        case 'readDeep': {
          let best='', bestLen=0;
          const all=document.body.querySelectorAll('div,p,section,article');
          for(const el of all){if(el.offsetHeight===0)continue;if(el.closest('textarea')||el.closest('[class*="input"]'))continue;const t=(el.innerText||'').trim();if(t.length>bestLen&&t.length<50000){best=t;bestLen=t.length;}}
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
          const stopBtn = document.querySelector('button[aria-label*="Stop"]');
          if (stopBtn) return { generating: true };
          return { generating: false };
        }
        default:
          throw new Error('Unknown action: ' + msg.action);
      }
    })()
      .then(sendResponse)
      .catch((err) => { console.error('[Gemini]', err); sendResponse({ error: err.message }); });
    return true;
  });

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

  async function waitForInput(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = $(S.input);
      if (el) return el;
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }

  async function findSubmitBtn(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let btn = $(S.submit);
      if (btn && !btn.disabled) return btn;
      const all = document.querySelectorAll('button:not([disabled])');
      for (const b of all) {
        if (b.offsetHeight > 0 && (b.textContent?.includes('Send') || b.ariaLabel?.includes('Send'))) return b;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }

  console.log('[Gemini] Content script loaded');
})();
