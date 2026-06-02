(function () {
  'use strict';

  const S = {
    input: ['#prompt-textarea', 'div[contenteditable="true"]'],
    submit: [
      'button[data-testid="send-button"]',
      'button.composer-submit-button-color:not([disabled])',
      'button[aria-label*="Send"]:not([disabled])',
    ],
    response: ['[data-turn="assistant"]'],
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

  function getInput() { return $(S.input); }
  let lastInjected = '';
  let baselineAssistantCount = 0;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.action) {
        case 'ping': return { ok: true };
        case 'inject': {
          const el = getInput();
          if (!el) throw new Error('ChatGPT: input not found');
          baselineAssistantCount = ($$(S.response)?.length || 0);
          lastInjected = msg.text || '';

          /* Clear existing content and inject text */
          el.focus();
          el.innerHTML = '';
          const p = document.createElement('p');
          p.textContent = msg.text;
          el.appendChild(p);

          /* Dispatch ProseMirror-compatible input events */
          el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: msg.text }));
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: msg.text }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));

          console.log('[GPT] Injected:', msg.text.slice(0, 60));
          return { ok: true };
        }
        case 'submit': {
          const btn = await findSubmitBtn();
          if (!btn) throw new Error('ChatGPT: could not find submit button');
          btn.click();
          console.log('[GPT] Clicked submit');
          return { ok: true };
        }
        case 'read': {
          const text = readResponse() || '';
          return { text };
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
        default:
          throw new Error('Unknown action: ' + msg.action);
      }
    })()
      .then(sendResponse)
      .catch((err) => {
        console.error('[GPT]', err);
        sendResponse({ error: err.message });
      });
    return true;
  });

  function readResponse() {
    const els = $$(S.response);
    if (els) {
      for (let i = els.length - 1; i >= 0; i--) {
        if (i < baselineAssistantCount) break;
        const t = els[i].innerText?.trim();
        if (t && t.length > 10 && !isUserEcho(t)) return t;
        const img = els[i].querySelector('img[alt*="Generated"]');
        if (img) return img.getAttribute('alt') || '';
      }
    }
    return '';
  }

  function isUserEcho(text) {
    if (!lastInjected) return false;
    return text.includes(lastInjected) || lastInjected.includes(text);
  }

  async function findSubmitBtn(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let btn = $(S.submit);
      if (btn && !btn.disabled) return btn;

      /* Fallback: look for any enabled button in the composer area */
      const composer = document.querySelector('[class*="composer"]');
      if (composer) {
        const btns = composer.querySelectorAll('button:not([disabled])');
        for (const b of btns) {
          const label = (b.ariaLabel || b.textContent || '').toLowerCase();
          if (label.includes('send') || b.className.includes('submit')) return b;
        }
      }

      await new Promise((r) => requestAnimationFrame(r));
    }
    return null;
  }

  console.log('[GPT] Content script loaded');
})();
