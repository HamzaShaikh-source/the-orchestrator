(function () {
  'use strict';

  /* Auto-healing selectors — scans DOM when predefined selectors fail */
  const S = {
    input: ['textarea', 'div[contenteditable="true"]', '[contenteditable]'],
    submit: [
      'div.ds-button--primary.ds-button--filled',
      'div[role="button"].ds-button--primary',
      'div.ds-button--iconLabelPrimary',
      'div[role="button"]',
      'button[type="submit"]',
    ],
    response: [
      '.ds-assistant-message-main-content',
      '.ds-markdown',
      '.ds-message',
      '.ds-assistant-message',
      '[class*="message-content"]',
      '[class*="ds-assistant"]',
      '[class*="ds-turn-"]',
      '[class*="markdown"]',
      '[class*="ds-chat"]',
      '[class*="ds-msg"]',
      '[class*="conversation"]',
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
    let el = $(S.input);
    if (!el) {
      /* Auto-heal: find any visible textarea or contenteditable */
      el = document.querySelector('textarea:not([disabled]):not([hidden])');
      if (!el) el = document.querySelector('[contenteditable="true"]:not([hidden])');
      if (!el) el = document.querySelector('input[type="text"]:not([disabled])');
    }
    return el;
  }

  function findSubmit() {
    let btn = $(S.submit);
    if (btn && btn.offsetHeight > 0) return btn;
    /* Auto-heal: find submit-like buttons near the input */
    const input = getInput();
    if (input) {
      const parent = input.closest('div, section') || input.parentElement;
      if (parent) {
        const all = parent.querySelectorAll('button, div[role="button"], [class*="button"]');
        for (const b of all) {
          if (b.offsetHeight > 0 && !b.disabled) {
            const text = (b.textContent || '').toLowerCase();
            if (text.includes('send') || text.includes('submit') || b === all[all.length - 1]) return b;
          }
        }
      }
    }
    /* Last resort: any visible button */
    const allBtns = document.querySelectorAll('button:not([disabled]), div[role="button"]:not([disabled])');
    for (const b of allBtns) {
      if (b.offsetHeight > 0) return b;
    }
    return null;
  }

  function getResponses() {
    let els = $$(S.response);
    if (els && els.length > 0) return els;
    
    /* Auto-heal: carefully scan for response content */
    const mainArea = document.querySelector('main, [class*="conversation"], [class*="chat"], [class*="message"], [role="main"]') || document.body;
    const allEls = mainArea.querySelectorAll('div, p, section, article, [class*="markdown"], [class*="content"]');
    const candidates = [];
    for (const el of allEls) {
      if (el.offsetHeight === 0) continue;
      if (el.children.length > 5) continue; /* Skip containers with many children (likely layout) */
      if (el.closest('[class*="input"]') || el.closest('[class*="composer"]') || el.closest('textarea')) continue;
      const text = (el.innerText || '').trim();
      if (text.length < 50) continue;
      /* Filter out known UI text */
      if (text.length < 200 && (text.includes('AI-generated') || text.includes('DeepThink'))) continue;
      candidates.push(el);
    }
    if (candidates.length > 0) {
      /* Get the most specific elements (innermost) */
      const inner = candidates.filter(c => !candidates.some(other => other !== c && other.contains(c)));
      const best = inner.length > 0 ? inner : candidates;
      /* Clean UI phrases from text */
      best.forEach(el => {
        let t = el.innerText || '';
        t = t.replace(/AI-generated, for reference only/g, '');
        t = t.replace(/Instant|DeepThink|Search/g, '').trim();
        el._cleanText = t;
      });
      return best;
    }
    return null;
  }

  let lastInjected = '';
  let baselineAssistantCount = 0;

  const observer = new MutationObserver(() => {});
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.action) {
        case 'ping': return { ok: true };
        case 'inject': {
          const el = getInput();
          if (!el) throw new Error('DeepSeek: input not found');
          const responses = getResponses();
          baselineAssistantCount = responses ? responses.length : 0;
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
        case 'readDeep': {
          /* Deep scan: return the LARGEST text element that isn't the input */
          const allDivs = document.querySelectorAll('div, p, section');
          let best = '', bestLen = 0;
          for (const el of allDivs) {
            if (el.offsetHeight === 0) continue;
            if (el.closest('textarea') || el.closest('[class*="input"]') || el.closest('[class*="composer"]')) continue;
            const t = (el.innerText || '').trim();
            if (t.length > bestLen && t.length < 50000) {
              /* Skip known UI text */
              if (t.includes('AI-generated') && t.length < 500) continue;
              if (t === 'Instant' || t === 'DeepThink' || t === 'Search') continue;
              best = t; bestLen = t.length;
            }
          }
          return { text: best };
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
      .catch((err) => { console.error('[DS]', err); sendResponse({ error: err.message }); });
    return true;
  });

  async function submit() {
    const btn = findSubmit();
    if (btn) {
      btn.click();
      console.log('[DS] Submit via button');
      return;
    }
    /* Fallback: Enter key */
    const el = getInput();
    if (el) {
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', keyCode: 13, which: 13, code: 'Enter',
        bubbles: true, cancelable: true,
      }));
      console.log('[DS] Submit via Enter');
      return;
    }
    throw new Error('DeepSeek: could not submit');
  }

  const PLACEHOLDER_PATTERNS = [
    /^thinking/i, /^thinking\.\.\.$/i, /^thinking…$/i,
    /^\d+\.\s*thinking/i, /^the\s+model\s+is\s+thinking/i,
    /^searching/i, /^searching\.\.\.$/i,
  ];

  function isPlaceholder(text) {
    const t = text.trim().toLowerCase();
    if (t.length < 3) return true;
    for (const p of PLACEHOLDER_PATTERNS) { if (p.test(t)) return true; }
    if (t === 'edit' || t === 'generating...' || t === 'thinking...') return true;
    return false;
  }

  function readResponse() {
    const els = getResponses();
    if (!els || els.length === 0) return '';
    for (let i = els.length - 1; i >= baselineAssistantCount; i--) {
      if (i < 0) break;
      const raw = els[i]?.innerText?.trim() || '';
      /* Use cleaned text if available, otherwise raw */
      const t = els[i]._cleanText || raw;
      if (t && !isPlaceholder(t)) return t;
    }
    return '';
  }

  console.log('[DS] Content script loaded (auto-heal enabled)');
})();
