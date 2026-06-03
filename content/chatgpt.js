(function() {
  'use strict';

  const S = {
    input: ['#prompt-textarea', 'div[contenteditable="true"]'],
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

  let lastInjected = '';
  let baselineCount = 0;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.action) {
        case 'ping': return { ok: true };

        case 'inject': {
          const el = S.input.reduce((found, s) => found || document.querySelector(s), null);
          if (!el) throw new Error('ChatGPT: input not found');
          baselineCount = document.querySelectorAll(S.response.join(',')).length;
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
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: msg.text }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
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
          const responses = document.querySelectorAll(S.response.join(','));
          for (let i = responses.length - 1; i >= baselineCount; i--) {
            const t = responses[i].innerText?.trim();
            if (t && t.length > 10 && !t.includes(lastInjected)) { text = t; break; }
            /* Check for generated images */
            const img = responses[i].querySelector('img[alt*="Generated"]');
            if (img) { text = img.getAttribute('alt') || ''; break; }
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
      for (const sel of S.submit) {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled && btn.offsetParent !== null) return btn;
      }
      /* Fallback: any enabled button in composer area */
      const composer = document.querySelector('[class*="composer"]');
      if (composer) {
        const btns = composer.querySelectorAll('button:not([disabled])');
        for (const b of btns) {
          const label = (b.ariaLabel || b.textContent || '').toLowerCase();
          if (label.includes('send') || b.className.includes('submit')) return b;
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }
})();
