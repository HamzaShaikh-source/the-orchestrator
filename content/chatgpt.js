(function() {
  'use strict';

  const S = {
    input: ['#prompt-textarea', 'textarea', 'div[contenteditable="true"]'],
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

  /* Try to dismiss ChatGPT welcome/onboarding dialogs */
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function dismissWelcome() {
    /* Send Escape key to dismiss overlays */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    /* Click on the main area to dismiss focused dialogs */
    const main = document.querySelector('main, [class*="composer"], [class*="conversation"]');
    if (main) main.click();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.action) {
        case 'ping': return { ok: true };

        case 'inject': {
          dismissWelcome();
          await sleep(500);
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
            /* Skip short/placeholder responses like "Edit" (DALL-E placeholder) */
            if (!t || t.length < 5 || t === 'Edit' || t === 'edit') {
              /* Check for generated images */
              const img = responses[i].querySelector('img[alt*="Generated"]');
              if (img) { text = img.getAttribute('alt') || ''; break; }
              continue;
            }
            if (t && !t.includes(lastInjected)) { text = t; break; }
          }
          return { text };
        }

        case 'checkLogin': {
          const hasLogin = [...document.querySelectorAll('a, button')].some(el => /log in|sign in|sign up/i.test(el.innerText));
          return { loggedIn: !hasLogin };
        }

        case 'isGenerating': {
          /* ChatGPT: during generation, the send button becomes a stop square. Check for stop button first. */
          const allBtns = document.querySelectorAll('button');
          for (const btn of allBtns) {
            if (btn.offsetHeight === 0) continue;
            const ariaLabel = (btn.ariaLabel || '').toLowerCase();
            const text = (btn.textContent || '').toLowerCase();
            if (ariaLabel.includes('stop') || text.includes('stop') || btn.className.includes('stop')) {
              return { generating: true };
            }
          }
          /* Check send button state */
          const sendBtn = document.querySelector('button[data-testid="send-button"]');
          if (sendBtn && sendBtn.disabled) return { generating: true };
          if (sendBtn && !sendBtn.disabled) return { generating: false };
          return { generating: false };
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
