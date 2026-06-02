(function () {
  'use strict';

  const S = {
    input: ['textarea', 'div[contenteditable="true"]'],
    submit: [
      'div.ds-button--primary.ds-button--filled',
      'div[role="button"].ds-button--primary',
      'div[role="button"]',
    ],
    response: [
      '.ds-assistant-message-main-content',
      '.ds-markdown',
      '.ds-message',
    ],
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

  function getInput() {
    return $(S.input);
  }

  let lastInjected = '';
  let baselineAssistantCount = 0;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.action) {
        case 'ping': return { ok: true };
        case 'inject': {
          const el = getInput();
          if (!el) throw new Error('DeepSeek: input not found');
          baselineAssistantCount = ($$(S.response)?.length || 0);
          lastInjected = msg.text;
          el.focus();
          if (typeof el.value !== 'undefined') {
            el.value = msg.text;
            el.selectionStart = el.selectionEnd = msg.text.length;
          } else {
            el.innerHTML = '';
            const p = document.createElement('p');
            p.textContent = msg.text;
            el.appendChild(p);
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: msg.text }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
          console.log('[DS] Injected:', msg.text.slice(0, 60));
          return { ok: true };
        }
        case 'submit': {
          await submit();
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
        console.error('[DS]', err);
        sendResponse({ error: err.message });
      });
    return true;
  });

  async function submit() {
    const btn = await waitForEnabledBtn();
    if (btn) {
      btn.click();
      console.log('[DS] Submit via button click');
      return;
    }
    /* Fallback: Enter key */
    const el = getInput();
    if (el) {
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
      console.log('[DS] Submit via Enter key');
      return;
    }
    throw new Error('DeepSeek: could not submit');
  }

  function waitForEnabledBtn(timeout = 10000) {
    return new Promise((resolve) => {
      const start = Date.now();
      function check() {
        const btn = $(S.submit);
        if (btn && !btn.className.includes('ds-button--disabled')) {
          return resolve(btn);
        }
        if (Date.now() - start > timeout) return resolve(null);
        requestAnimationFrame(check);
      }
      check();
    });
  }

  const PLACEHOLDER_PATTERNS = [
    /^thinking/i, /^thinking\.\.\.$/i, /^thinking…$/i,
    /^\d+\.\s*thinking/i, /^the\s+model\s+is\s+thinking/i,
    /^searching/i, /^searching\.\.\.$/i,
  ];

  function isPlaceholder(text) {
    const t = text.trim().toLowerCase();
    if (t.length < 15) return true;
    for (const p of PLACEHOLDER_PATTERNS) {
      if (p.test(t)) return true;
    }
    return false;
  }

  function isUserMessage(text) {
    if (!lastInjected) return false;
    return text.includes(lastInjected) || lastInjected.includes(text);
  }

  function readResponse() {
    const els = $$(S.response);
    if (els) {
      for (let i = els.length - 1; i >= 0; i--) {
        if (i < baselineAssistantCount) break;
        const t = els[i].innerText?.trim();
        if (t && t.length > 10 && !isPlaceholder(t) && !isUserMessage(t)) return t;
      }
    }
    return '';
  }

  console.log('[DS] Content script loaded');
})();
