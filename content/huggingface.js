(function () {
  'use strict';

  /* HuggingChat content script (https://huggingface.co/chat/) */

  /* Check for chat subdomain hostname variation */
  const HF_HOST = window.location.hostname;
  if (!HF_HOST.includes('huggingface') && !HF_HOST.includes('hf.co')) {
    console.warn('[HF] Unexpected hostname:', HF_HOST);
  }

  const S = {
    input: ['textarea', 'input[type="text"]', '#chat-input', '[data-testid*="input"]', 'div[contenteditable="true"]'],
    submit: ['button[type="submit"]', 'button[aria-label*="Send"]', '[data-testid*="send"]', '.run-button'],
    response: ['.output', '.result', '.generation', '.output-area', '.result-box', '.prose', '[data-testid*="message"]', '.message', '.message-bot'],
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.action) {
        case 'ping': return { ok: true };
        case 'inject': {
          const el = $(S.input);
          if (!el) throw new Error('HF: input not found');
          baselineCount = ($$(S.response)?.length || 0);
          lastInjected = msg.text || '';
          el.focus();
          if (typeof el.value !== 'undefined') {
            el.value = msg.text;
          } else {
            el.innerHTML = '';
            const p = document.createElement('p');
            p.textContent = msg.text;
            el.appendChild(p);
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: msg.text }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          console.log('[HF] Injected:', msg.text.slice(0, 60));
          return { ok: true };
        }
        case 'submit': {
          const btn = await findBtn();
          if (!btn) throw new Error('HF: could not find submit button');
          btn.click();
          console.log('[HF] Clicked submit');
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
      .catch((err) => { console.error('[HF]', err); sendResponse({ error: err.message }); });
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

  async function findBtn(timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let btn = $(S.submit);
      if (btn && !btn.disabled && !btn.hasAttribute('aria-disabled')) return btn;
      /* Fallback: any enabled visible button near the input */
      const all = document.querySelectorAll('button:not([disabled])');
      for (const b of all) {
        if (b.offsetHeight > 0 && b.offsetWidth > 0) {
          /* Prefer buttons with send/submit-like text */
          const txt = (b.textContent || '').toLowerCase();
          if (txt.includes('send') || txt.includes('submit') || txt.includes('generate') || b.id.includes('send')) return b;
        }
      }
      /* Last resort: first visible button */
      for (const b of all) {
        if (b.offsetHeight > 0 && b.offsetWidth > 0) return b;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  console.log('[HF] Content script loaded');
})();
