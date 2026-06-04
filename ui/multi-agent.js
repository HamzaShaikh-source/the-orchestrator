const $ = id => document.getElementById(id.replace('#', ''));
let pollTimer = null, running = false, currentChatId = null, selectedAgents = [];
let projectFiles = {}, attachedFiles = [];
let taskStartTimes = {}; /* Track when each task started for time estimation */
let pipelineStartTime = null; /* Track overall pipeline start */

function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  toast.style.cssText = `position:fixed; bottom:20px; right:20px; background:#1a1a24; border:1px solid ${type==='error'?'#f44250':'#10a37f'}; border-radius:8px; padding:10px 16px; z-index:9999; color:white; font-size:13px; box-shadow:0 4px 16px rgba(0,0,0,0.4); animation:fadeOut 3s forwards;`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

/* ── Agent strip ── */
function renderAgentCards() {
  const strip = $('#agent-strip');
  if (!strip) return;
  strip.innerHTML = allActiveAgents().map(a => `
    <div class="agent-chip ${selectedAgents.includes(a.id) ? 'selected' : ''}" data-agent="${a.id}">
      <span>${a.icon}</span> ${a.name}
      <span class="dot" id="dot-${a.id}"></span>
    </div>
  `).join('');
  strip.querySelectorAll('.agent-chip').forEach(card => {
    card.addEventListener('click', () => {
      if (running) return;
      const id = card.dataset.agent;
      const idx = selectedAgents.indexOf(id);
      if (idx >= 0) selectedAgents.splice(idx, 1);
      else selectedAgents.push(id);
  /* Recover pipeline state if page was refreshed mid-run */
  const savedState = sessionStorage.getItem('pipelineState');
  if (savedState) {
    try {
      const parsed = JSON.parse(savedState);
      if (parsed.projectFiles) projectFiles = parsed.projectFiles;
      sessionStorage.removeItem('pipelineState');
    } catch {}
  }

  renderAgentCards();
    });
  });
}

function highlightAgents(ids) {
  document.querySelectorAll('.agent-chip').forEach(c => c.classList.remove('selected'));
  ids.forEach(id => document.querySelector(`.agent-chip[data-agent="${id}"]`)?.classList.add('selected'));
}

function setAgentStatus(id, status) {
  const dot = $(`dot-${id}`);
  if (dot) dot.className = `dot ${status}`;
}

/* ── Tasks ── */
function renderTasks(tasks, editable) {
  const container = $('#task-list');
  if (!tasks?.length) { $('#tasks-section').classList.add('hidden'); return; }
  $('#tasks-section').classList.remove('hidden');
  container.innerHTML = tasks.map((t, i) => `
    <div class="task-tile">
      <div class="tile-num">#${i+1}</div>
      <div class="tile-body">
        <div class="tile-status ${t.status}">${t.status||'pending'}</div>
        <div class="tile-desc">${editable ? `<textarea data-index="${i}" class="tile-edit">${escapeHtml(t.description)}</textarea>` : escapeHtml(t.description)}</div>
        <div class="tile-agent">→ ${t.assignedTo || 'unassigned'}</div>
        ${t.status === 'error' ? `<button class="retry-task" data-index="${i}" style="margin-top:6px;background:transparent;border:1px solid var(--danger);border-radius:40px;padding:4px 12px;font-size:0.7rem;cursor:pointer;color:var(--danger)">⟳ Retry</button>` : ''}
      </div>
    </div>
  `).join('');
}

/* ── Outputs ── */
function renderOutputs(agentOutputs) {
  const container = $('#outputs-list');
  if (!agentOutputs || !Object.keys(agentOutputs).length) { $('#outputs-section').classList.add('hidden'); return; }
  $('#outputs-section').classList.remove('hidden');
  /* Show compare button if there are other chats */
  listChats().then(chats => {
    const hasOther = chats.some(c => c.id !== currentChatId && c.results?.agentOutputs);
    if (hasOther) document.getElementById('compare-btn')?.style.removeProperty('display');
  });
  /* Collapsed by default — show only counts */
  const total = Object.keys(agentOutputs).length;
  const done = Object.values(agentOutputs).filter(d => d.status === 'done').length;
  const errored = Object.values(agentOutputs).filter(d => d.status === 'error').length;
  container.innerHTML = `
    <div class="outputs-summary" id="outputs-summary">
      <span>${total} agents · ${done} done · ${errored} errored</span>
      <button id="toggle-outputs" style="background:none;border:1px solid var(--border);border-radius:40px;padding:4px 14px;font-size:0.75rem;cursor:pointer;color:var(--text-secondary)">Show details</button>
    </div>
    <div id="outputs-detail" style="display:none">
      ${Object.entries(agentOutputs).map(([id, data]) => {
        const agent = getAgent(id);
        if (!agent) return '';
        const badge = data.status === 'streaming' ? '⏳' : data.status === 'done' ? '✅' : data.status === 'error' ? '❌' : '';
        const text = data.output || data.error || 'Waiting...';
        return `<div class="output-card">
          <div class="header"><span>${agent.icon}</span> ${agent.name} <span style="margin-left:auto">${badge}</span></div>
          <div class="body">${highlightSyntax(text)}</div>
          <button class="copy-output" data-text="${escapeAttr(text)}" style="margin-top:8px;background:transparent;border:1px solid var(--line);border-radius:20px;padding:4px 12px;font-size:11px;cursor:pointer;color:var(--text-secondary)">📋 Copy</button>
        </div>`;
      }).join('')}
    </div>
  `;
  /* Toggle details */
  const toggle = document.getElementById('toggle-outputs');
  if (toggle) toggle.onclick = () => {
    const detail = document.getElementById('outputs-detail');
    const isHidden = detail.style.display === 'none';
    detail.style.display = isHidden ? 'block' : 'none';
    toggle.textContent = isHidden ? 'Hide details' : 'Show details';
  };
  document.querySelectorAll('.copy-output').forEach(btn => {
    btn.addEventListener('click', () => navigator.clipboard.writeText(btn.dataset.text).then(() => showToast('Copied!')).catch(() => {}));
  });
}

function syncFilesFromAI(agentOutputs) {
  if (!agentOutputs) return;
  let changed = false;
  const FILE_RE = /<file\s+name=["']([^"']+)["']>([\s\S]*?)<\/file>/gi;
  for (const [, data] of Object.entries(agentOutputs)) {
    if (!data.output) continue;
    let match;
    while ((match = FILE_RE.exec(data.output))) {
      const name = match[1].trim(), content = match[2].trim();
      if (projectFiles[name] !== content) { projectFiles[name] = content; changed = true; }
    }
  }
  if (changed) renderFilePanel();
}

/* Also scan synthesis text for file tags */
function syncFilesFromSynthesis(synthText) {
  if (!synthText) return;
  let changed = false;
  const FILE_RE = /<file\s+name=["']([^"']+)["']>([\s\S]*?)<\/file>/gi;
  let match;
  while ((match = FILE_RE.exec(synthText))) {
    const name = match[1].trim(), content = match[2].trim();
    if (projectFiles[name] !== content) { projectFiles[name] = content; changed = true; }
  }
  if (changed) renderFilePanel();
}

function renderFilePanel() {
  const names = Object.keys(projectFiles);
  if (names.length === 0) return;
  
  const old = document.getElementById('file-panel-output');
  if (old) old.remove();

  const content = document.getElementById('content');
  if (!content) return;

  const panel = document.createElement('div');
  panel.id = 'file-panel-output';
  panel.style.cssText = 'margin-top:16px;padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)';
  panel.innerHTML = `
    <div style="font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:16px">✅ Generated Files (${names.length})</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px">
    ${names.map(n => {
      const ext = n.split('.').pop();
      const icon = ext === 'html' ? '🌐' : ext === 'css' ? '🎨' : ext === 'js' ? '⚡' : ext === 'json' ? '📋' : ext === 'md' ? '📝' : '📄';
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface-hover);border-radius:var(--radius-sm);border:1px solid var(--border);cursor:pointer" class="file-item-clickable" data-name="${escapeAttr(n)}">
        <span style="font-size:1.2rem">${icon}</span>
        <div style="flex:1;min-width:0">
          <div style="font-family:monospace;font-size:0.8rem;font-weight:600;overflow:hidden;text-overflow:ellipsis">${escapeHtml(n)}</div>
          <div style="font-size:0.65rem;color:var(--text-muted)">${(projectFiles[n].length / 1024).toFixed(1)} KB</div>
        </div>
        <button class="copy-file" data-name="${escapeAttr(n)}" style="background:none;border:1px solid var(--border);border-radius:20px;padding:4px 10px;font-size:0.7rem;cursor:pointer;color:var(--text-secondary)">📋</button>
        <button class="edit-file" data-name="${escapeAttr(n)}" style="background:none;border:1px solid var(--border);border-radius:20px;padding:4px 10px;font-size:0.7rem;cursor:pointer;color:var(--text-secondary)">✏️</button>
      </div>`;
    }).join('')}
    </div>
    <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
      <button id="download-zip-btn" style="background:var(--accent);color:white;border:none;border-radius:40px;padding:10px 24px;font-weight:600;cursor:pointer;font-size:0.85rem">⬇ Download All (.zip)</button>
      <button id="preview-html-btn" style="background:transparent;color:var(--text);border:1px solid var(--border);border-radius:40px;padding:10px 24px;font-weight:500;cursor:pointer;font-size:0.85rem">&#x1f441; Preview HTML</button>
    </div>
    <div id="preview-container" style="display:none;margin-top:12px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;height:400px">
      <iframe id="preview-iframe" style="width:100%;height:100%;border:none;background:white"></iframe>
    </div>
  `;

  /* Append panel to content area */
  content.appendChild(panel);

  /* Wire up copy buttons */
  panel.querySelectorAll('.copy-file').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const content = projectFiles[btn.dataset.name] || '';
      navigator.clipboard.writeText(content).then(() => showToast('Copied ' + btn.dataset.name));
    });
  });

  /* Wire up edit buttons — open file in modal for editing */
  panel.querySelectorAll('.edit-file').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.dataset.name;
      const content = projectFiles[name] || '';
      const newContent = prompt(`Edit ${name}:`, content.substring(0, 5000));
      if (newContent !== null) {
        projectFiles[name] = newContent;
        showToast(`Saved ${name}`, 'success');
      }
    });
  });

  /* Wire up download button */
  const dlBtn = document.getElementById('download-zip-btn');
  if (dlBtn) {
    dlBtn.addEventListener('click', () => {
      const files = Object.entries(projectFiles).map(([name, content]) => ({ name, content }));
      if (files.length === 0) return showToast('No files to download', 'error');
      
      /* Build ZIP using simple concatenation */
      /* Local file header (30 bytes) + filename + file data for each file */
      /* Then central directory (46 bytes + filename) for each file */
      /* Then end of central directory record (22 bytes) */
      const enc = new TextEncoder();
      const parts = [];
      let offset = 0;
      const centralParts = [];
      
      for (const f of files) {
        const data = enc.encode(f.content);
        const name = enc.encode(f.name);
        const crc = (() => {
          let c = 0xffffffff;
          for (let i = 0; i < data.length; i++) { c ^= data[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); }
          return (c ^ 0xffffffff) >>> 0;
        })();
        const sz = data.length;
        const nl = name.length;
        
        /* Local file header */
        const buf = new ArrayBuffer(30);
        const v = new DataView(buf);
        v.setUint32(0, 0x04034b50, true); /* local file header signature */
        v.setUint16(4, 20, true); /* version needed */
        v.setUint16(6, 0, true); /* general purpose bit flag */
        v.setUint16(8, 0, true); /* compression method: stored */
        v.setUint16(10, 0, true); /* last mod file time */
        v.setUint16(12, 0, true); /* last mod file date */
        v.setUint32(14, crc, true); /* crc-32 */
        v.setUint32(18, sz, true); /* compressed size */
        v.setUint32(22, sz, true); /* uncompressed size */
        v.setUint16(26, nl, true); /* file name length */
        v.setUint16(28, 0, true); /* extra field length */
        parts.push(new Uint8Array(buf), name, data);
        
        /* Central directory entry */
        const cbuf = new ArrayBuffer(46);
        const cv = new DataView(cbuf);
        cv.setUint32(0, 0x02014b50, true); /* central directory file header signature */
        cv.setUint16(4, 20, true); /* version made by */
        cv.setUint16(6, 20, true); /* version needed to extract */
        cv.setUint16(8, 0, true); /* general purpose bit flag */
        cv.setUint16(10, 0, true); /* compression method: stored */
        cv.setUint16(12, 0, true); /* last mod file time */
        cv.setUint16(14, 0, true); /* last mod file date */
        cv.setUint32(16, crc, true); /* crc-32 */
        cv.setUint32(20, sz, true); /* compressed size */
        cv.setUint32(24, sz, true); /* uncompressed size */
        cv.setUint16(28, nl, true); /* file name length */
        cv.setUint16(30, 0, true); /* extra field length */
        cv.setUint16(32, 0, true); /* file comment length */
        cv.setUint16(34, 0, true); /* disk number start */
        cv.setUint16(36, 0, true); /* internal file attributes */
        cv.setUint32(38, 0, true); /* external file attributes */
        cv.setUint32(42, offset, true); /* relative offset of local header */
        centralParts.push({ header: new Uint8Array(cbuf), name });
        offset += 30 + nl + sz;
      }
      
      /* Add central directory entries */
      let centralSize = 0;
      for (const c of centralParts) {
        parts.push(c.header, c.name);
        centralSize += 46 + c.name.length;
      }
      
      /* End of central directory record */
      const eocd = new ArrayBuffer(22);
      const ev = new DataView(eocd);
      ev.setUint32(0, 0x06054b50, true); /* end of central dir signature */
      ev.setUint16(4, 0, true); /* number of this disk */
      ev.setUint16(6, 0, true); /* disk where central directory starts */
      ev.setUint16(8, files.length, true); /* number of central directory records on this disk */
      ev.setUint16(10, files.length, true); /* total number of central directory records */
      ev.setUint32(12, centralSize, true); /* size of central directory */
      ev.setUint32(16, offset, true); /* offset of start of central directory */
      ev.setUint16(20, 0, true); /* ZIP file comment length */
      parts.push(new Uint8Array(eocd));
      
      /* Calculate total length and merge */
      const totalLen = parts.reduce((s, p) => s + p.length, 0);
      const merged = new Uint8Array(totalLen);
      let pos = 0;
      for (const p of parts) { merged.set(p, pos); pos += p.length; }
      
      const blob = new Blob([merged], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'project-files.zip';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 3000);
      showToast('Downloaded project-files.zip');
    });
  }
  
  /* Preview HTML button handler */
  setTimeout(() => {
    const previewBtn = document.getElementById('preview-html-btn');
    if (previewBtn) {
      previewBtn.onclick = () => {
        const htmlFile = Object.entries(projectFiles).find(([name]) => name.endsWith('.html'));
        if (!htmlFile) { showToast('No HTML file to preview', 'error'); return; }
        const container = document.getElementById('preview-container');
        const iframe = document.getElementById('preview-iframe');
        if (!container || !iframe) return;
        if (container.style.display === 'block') {
          container.style.display = 'none';
          return;
        }
        const blob = new Blob([htmlFile[1]], { type: 'text/html' });
        iframe.src = URL.createObjectURL(blob);
        container.style.display = 'block';
        previewBtn.textContent = '✕ Close Preview';
        /* Reset button text when preview is closed */
        const observer = new MutationObserver(() => {
          if (container.style.display === 'none') previewBtn.textContent = '👁 Preview HTML';
        });
        observer.observe(container, { attributes: true, attributeFilter: ['style'] });
      };
    }
  }, 100);
}

function renderSynthesis(text) {
  /* Strip <file> tags from displayed text (they're extracted to the file panel) */
  const displayText = text ? text.replace(/<file\s+name=["'][^"']+["']>[\s\S]*?<\/file>/gi, '').trim() : '';
  $('#synth-section').classList.toggle('hidden', !displayText);
  $('#synth-body').textContent = displayText || '';
  /* Also scan synthesis for file tags */
  if (text && running) {
    syncFilesFromSynthesis(text);
  }
}

/* Export */
async function exportResults() {
  const goal = $('#goal-input').value || 'Chat';
  const synth = $('#synth-body')?.textContent || '';
  let md = `# ${goal}\n\n${synth}\n\n`;
  for (const [name, content] of Object.entries(projectFiles)) {
    md += `## ${name}\n\`\`\`\n${content}\n\`\`\`\n\n`;
  }
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'orchestrator.md'; a.click();
  URL.revokeObjectURL(url); showToast('Exported!');
}
$('#export-btn')?.addEventListener('click', exportResults);

/* ── Compare outputs ── */
async function showCompareSelector() {
  const chats = await listChats();
  const options = chats.filter(c => c.id !== currentChatId && c.results?.agentOutputs).map(c => 
    `${c.id}:${(c.title || 'Chat').substring(0, 40)}`
  );
  if (options.length === 0) { showToast('No other chats with outputs to compare', 'error'); return; }
  const choice = prompt('Select chat to compare:\n' + options.map((o, i) => `${i}: ${o.split(':')[1]}`).join('\n'));
  if (choice === null) return;
  const idx = parseInt(choice);
  if (isNaN(idx) || idx < 0 || idx >= options.length) { showToast('Invalid selection', 'error'); return; }
  const chatId = options[idx].split(':')[0];
  const chat = await getChat(chatId);
  if (!chat?.results?.agentOutputs) { showToast('No outputs to compare', 'error'); return; }
  /* Show comparison in a modal-like overlay */
  const current = window._lastAgentOutputs || {};
  const other = chat.results.agentOutputs;
  const compareHtml = Object.keys({ ...current, ...other }).map(id => {
    const agent = getAgent(id);
    const name = agent?.name || id;
    const curText = (current[id]?.output || '').substring(0, 500);
    const othText = (other[id]?.output || '').substring(0, 500);
    const same = curText === othText;
    return `<div style="margin-bottom:16px;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm)">
      <div style="font-weight:600;margin-bottom:8px;font-size:0.85rem">${name} ${same ? '✅ identical' : '⚠️ different'}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:0.75rem">
        <div><div style="color:var(--text-muted);margin-bottom:4px">Current run:</div><pre style="white-space:pre-wrap;background:var(--surface-2);padding:8px;border-radius:4px;max-height:200px;overflow-y:auto">${escapeHtml(curText)}</pre></div>
        <div><div style="color:var(--text-muted);margin-bottom:4px">Compared chat:</div><pre style="white-space:pre-wrap;background:var(--surface-2);padding:8px;border-radius:4px;max-height:200px;overflow-y:auto">${escapeHtml(othText)}</pre></div>
      </div>
    </div>`;
  }).join('');
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:24px;max-width:800px;width:90%;max-height:80vh;overflow-y:auto">
    <div style="display:flex;justify-content:space-between;margin-bottom:16px">
      <span style="font-weight:600;font-size:1rem">📊 Output Comparison</span>
      <button id="close-compare" style="background:none;border:none;color:var(--text);font-size:1.2rem;cursor:pointer">✕</button>
    </div>
    ${compareHtml}
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#close-compare').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}
$('#compare-btn')?.addEventListener('click', showCompareSelector);

/* ── Status & render ── */
function statusText(state) {
  if (state.step === 'login-check') return 'Checking logins...';
  if (state.step === 'planning') return 'Planning tasks...';
  if (state.step === 'confirm-tasks') return 'Review tasks and confirm';
  if (state.step === 'running') return `Executing (${state.tasks?.filter(t=>t.status==='done').length||0}/${state.tasks?.length||0})`;
  if (state.step === 'synthesis') return 'Synthesizing final output...';
  if (state.step === 'done') return 'Complete!';
  if (state.step === 'error') return `Error: ${state.error}`;
  return state.step || 'Ready';
}

function render(state) {
  const dot = $('#status-dot');
  const active = ['login-check', 'planning', 'confirm-tasks', 'running', 'synthesis'].includes(state.step);
  dot.className = `status-dot ${active ? 'working' : state.step==='done'?'done':state.step==='error'?'error':''}`;
  $('#status-text').textContent = statusText(state);

  /* Pipeline running display */
  const pd = $('#pipeline-display');
  const isRunning = ['running', 'synthesis', 'brain-writing', 'brain-executing', 'brain-reviewing'].includes(state.step);
  if (isRunning) {
    pd.classList.add('active');
    /* Update agent icon and action */
    const brainPhase = state.brainPhase || '';
    let icon = '🧠', name = 'Brain', action = 'Working';
    if (brainPhase.includes('DeepSeek')) { icon = '🧠'; name = 'DeepSeek'; }
    else if (brainPhase.includes('ChatGPT')) { icon = '💬'; name = 'ChatGPT'; }
    else if (brainPhase.includes('Gemini')) { icon = '✨'; name = 'Gemini'; }
    else if (brainPhase.includes('Perplexity')) { icon = '🔍'; name = 'Perplexity'; }
    else if (brainPhase.includes('Hugging')) { icon = '🤗'; name = 'HuggingFace'; }

    const phase = state.step === 'brain-writing' ? 'Brain is writing task assignment' :
                  state.step === 'brain-executing' ? 'Executing task' :
                  state.step === 'brain-reviewing' ? 'Brain is reviewing output' :
                  state.step === 'synthesis' ? 'Brain is synthesizing results' :
                  brainPhase || 'Working';
    action = phase;

    $('#pd-agent-icon').textContent = icon;
    $('#pd-agent-name').textContent = name;
    $('#pd-action-text').textContent = action;
    const total = state.tasks?.length || 0;
    const done = state.tasks?.filter(t => t.status === 'done' || t.status === 'error').length || 0;
    $('#pd-progress-text').textContent = `Task ${done} of ${total}`;
    $('#pd-progress-fill').style.width = total > 0 ? `${(done / total) * 100}%` : '0%';
    /* Time estimation */
    if (pipelineStartTime && done > 0) {
      const elapsed = (Date.now() - pipelineStartTime) / 1000;
      const avgPerTask = elapsed / done;
      const remaining = Math.round(avgPerTask * (total - done));
      const elapsedStr = elapsed > 60 ? `${Math.round(elapsed / 60)}m` : `${Math.round(elapsed)}s`;
      const remainStr = remaining > 60 ? `${Math.round(remaining / 60)}m` : `${Math.round(remaining)}s`;
      const timeEl = document.getElementById('pd-time');
      if (timeEl) timeEl.textContent = `${elapsedStr} elapsed · ~${remainStr} remaining`;
    }

    /* Generate background floating dots */
    if (!pd._dots) {
      pd._dots = true;
      const bg = document.getElementById('pd-bg-dots');
      if (bg) {
        for (let i = 0; i < 12; i++) {
          const dot = document.createElement('div');
          dot.className = 'pd-bg-dot';
          dot.style.left = `${Math.random() * 100}%`;
          dot.style.animationDelay = `${Math.random() * 8}s`;
          dot.style.animationDuration = `${6 + Math.random() * 6}s`;
          dot.style.width = dot.style.height = `${4 + Math.random() * 8}px`;
          bg.appendChild(dot);
        }
      }
    }
  } else {
    pd.classList.remove('active');
    pd._dots = false;
    const bg = document.getElementById('pd-bg-dots');
    if (bg) bg.innerHTML = '';
  }

  renderTasks(state.tasks, state.step === 'confirm-tasks');
  /* Only sync files during active pipeline runs, not when viewing history */
  if (['running', 'brain-writing', 'brain-executing', 'brain-reviewing', 'synthesis', 'done'].includes(state.step)) {
    syncFilesFromAI(state.agentOutputs);
  }
  renderOutputs(state.agentOutputs);
  renderSynthesis(state.synthesis);
  /* Always render file panel if files exist */
  if (Object.keys(projectFiles).length > 0) renderFilePanel();
  $('#confirm-bar').style.display = state.step === 'confirm-tasks' ? 'flex' : 'none';
  if (state.selectedAgents) highlightAgents(state.selectedAgents);
  if (['done', 'error', 'cancelled'].includes(state.step)) {
    running = false; $('#run-btn').classList.remove('hidden'); $('#stop-btn').classList.add('hidden');
    stopPoll();
    /* Ensure file panel renders on completion */
    if (Object.keys(projectFiles).length > 0) {
      renderFilePanel();
      /* Auto-scroll to show files */
      setTimeout(() => {
        const fp = document.getElementById('file-panel-output');
        if (fp) fp.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    }
    /* Save project files to chat record */
    if (currentChatId && Object.keys(projectFiles).length > 0) {
      getChat(currentChatId).then(chat => {
        if (chat) { chat.projectFiles = { ...projectFiles }; saveChat(chat); }
      });
    }
    if (state.step === 'done') {
      showToast('✅ Pipeline complete!');
      /* Browser notification */
      if (Notification.permission === 'granted') {
        new Notification('The Orchestrator', { body: '✅ Pipeline completed!', icon: '../icons/icon128.png' });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission();
      }
    }
    else if (state.step === 'error') showToast('❌ Pipeline failed: ' + (state.error || ''), 'error');
  }
}

/* ── Polling ── */
async function fetchState() {
  try { 
    const s = await chrome.runtime.sendMessage({ action: 'multiStatus' }); 
    if (s) {
      render(s);
      /* Save state for recovery on page refresh */
      if (['running', 'brain-writing', 'brain-executing', 'brain-reviewing', 'synthesis'].includes(s.step)) {
        sessionStorage.setItem('pipelineState', JSON.stringify({ step: s.step, projectFiles }));
      }
    }
  } catch {}
}
function startPoll() { stopPoll(); pollTimer = setInterval(fetchState, 800); }
function stopPoll() { if (pollTimer) clearInterval(pollTimer); }

/* ── Drag-and-drop file upload ── */
const dropArea = document.getElementById('goal-input')?.parentElement;
if (dropArea) {
  dropArea.addEventListener('dragover', (e) => { e.preventDefault(); dropArea.style.opacity = '0.7'; });
  dropArea.addEventListener('dragleave', () => { dropArea.style.opacity = '1'; });
  dropArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropArea.style.opacity = '1';
    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      let content = '';
      if (f.type.startsWith('text/') || /\.(js|html|css|json|md|txt)$/i.test(f.name)) {
        content = await f.text();
      } else content = `[Binary file: ${f.name} - ${f.size} bytes]`;
      attachedFiles.push({ name: f.name, content });
    }
    $('#file-count').textContent = `${attachedFiles.length} file(s)`;
    const goal = $('#goal-input');
    if (attachedFiles.length && !goal.value.includes('Attached files:')) {
      goal.value += `\n\nAttached files:\n${attachedFiles.map(f => `--- ${f.name} ---\n${f.content.slice(0, 1500)}`).join('\n')}`;
    }
  });
}

/* ── File upload ── */
$('#file-upload')?.addEventListener('change', async e => {
  const files = Array.from(e.target.files);
  for (const f of files) {
    let content = '';
    if (f.type.startsWith('text/') || f.name.endsWith('.js') || f.name.endsWith('.html') || f.name.endsWith('.css') || f.name.endsWith('.json') || f.name.endsWith('.md')) {
      content = await f.text();
    } else content = `[Binary file: ${f.name} - ${f.size} bytes]`;
    attachedFiles.push({ name: f.name, content });
  }
  $('#file-count').textContent = `${attachedFiles.length} file(s)`;
  const goal = $('#goal-input');
  if (attachedFiles.length && !goal.value.includes('Attached files:')) {
    goal.value += `\n\nAttached files:\n${attachedFiles.map(f => `--- ${f.name} ---\n${f.content.slice(0, 1500)}`).join('\n')}`;
  }
  e.target.value = '';
});

/* ── Chat history ── */
async function renderChatList(filter) {
  const chats = await listChats();
  const list = $('#chat-list');
  if (!list) return;
  const searchInput = list.querySelector('#chat-search');
  list.innerHTML = '';
  if (searchInput) list.appendChild(searchInput);
  const filtered = filter ? chats.filter(c => (c.title || '').toLowerCase().includes(filter.toLowerCase())) : chats;
  filtered.forEach(c => {
    const div = document.createElement('div');
    div.className = `chat-item ${c.id===currentChatId?'active':''}`;
    div.dataset.id = c.id;
    div.innerHTML = `<div class="chat-title">${escapeHtml(c.title)}</div><div class="chat-meta"><span>${new Date(c.timestamp).toLocaleDateString()}</span><button class="del-chat" data-id="${c.id}" style="background:none;border:none;color:red;cursor:pointer;font-size:14px">×</button></div>`;
    list.appendChild(div);
  });
  list.querySelectorAll('.chat-item').forEach(el => {
    el.addEventListener('click', (e) => { if (!e.target.classList.contains('del-chat')) selectChat(el.dataset.id); });
    el.querySelector('.del-chat')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteChat(el.dataset.id);
      if (currentChatId === el.dataset.id) newChat();
      renderChatList(document.getElementById('chat-search')?.value);
    });
  });
  if (searchInput) {
    searchInput.oninput = () => renderChatList(searchInput.value);
  }
}

async function selectChat(id) {
  const chat = await getChat(id);
  if (!chat) return;
  currentChatId = id;
  $('#goal-input').value = chat.prompt || '';
  if (chat.results) {
    renderTasks(chat.results.tasks);
    renderOutputs(chat.results.agentOutputs);
    renderSynthesis(chat.results.synthesis);
    /* Restore this chat's files — don't let sync add more */
    if (chat.projectFiles) {
      projectFiles = { ...chat.projectFiles };
      renderFilePanel();
    }
  }
  if (chat.selectedAgents) highlightAgents(chat.selectedAgents);
  renderChatList();
}

function newChat() {
  currentChatId = null; selectedAgents = []; projectFiles = {};
  $('#goal-input').value = '';
  $('#status-text').textContent = 'Ready';
  $('#status-dot').className = 'status-dot';
  ['tasks-section', 'outputs-section', 'synth-section'].forEach(s => $(s)?.classList.add('hidden'));
  /* Remove file panel from DOM */
  const fp = document.getElementById('file-panel-output');
  if (fp) fp.remove();
  renderAgentCards();
  renderChatList();
}
$('#new-chat-btn')?.addEventListener('click', newChat);

/* ── Run / Stop ── */
$('#run-btn').addEventListener('click', async () => {
  if (running) return;
  const goal = $('#goal-input').value.trim();
  if (!goal) { showToast('Enter a goal first', 'error'); return; }
  running = true;
  pipelineStartTime = Date.now();
  taskStartTimes = {};
  projectFiles = {}; /* Clear files from previous runs */
  /* Remove old file panel */
  const oldFp = document.getElementById('file-panel-output');
  if (oldFp) oldFp.remove();
  attachedFiles = [];
  $('#run-btn').classList.add('hidden');
  $('#stop-btn').classList.remove('hidden');
  $('#status-dot').className = 'status-dot working';
  $('#status-text').textContent = 'Starting...';
  startPoll();

  if (!currentChatId) {
    const chat = await createChat(goal);
    currentChatId = chat.id;
    await saveChat(chat);
  }
  await renderChatList();
  allActiveAgents().forEach(a => setAgentStatus(a.id, 'idle'));

  chrome.runtime.sendMessage({
    action: 'runMulti',
    goal,
    selectedAgents: selectedAgents.length ? selectedAgents : null,
    chatId: currentChatId,
    projectFiles,
  });
});

$('#stop-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopMulti' });
  running = false;
  $('#run-btn').classList.remove('hidden');
  $('#stop-btn').classList.add('hidden');
  stopPoll();
  $('#status-text').textContent = 'Cancelled';
  $('#status-dot').className = 'status-dot error';
  showToast('Cancelled', 'error');
});

$('#confirm-tasks')?.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'confirmTasks' }));
$('#cancel-tasks')?.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'rejectTasks' }));

/* ── Retry single task ── */
document.addEventListener('click', (e) => {
  const retryBtn = e.target.closest('.retry-task');
  if (retryBtn) {
    const idx = parseInt(retryBtn.dataset.index);
    showToast('Retrying task...', 'info');
    chrome.runtime.sendMessage({ action: 'retryTask', taskIndex: idx });
  }
});

/* ── Keyboard shortcuts ── */
document.addEventListener('keydown', (e) => {
  /* Ctrl+Enter to run */
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (!running) $('#run-btn')?.click();
  }
  /* Escape to stop */
  if (e.key === 'Escape' && running) {
    $('#stop-btn')?.click();
  }
});

function escapeHtml(str) { return String(str).replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'); }
function escapeAttr(str) { return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function highlightSyntax(code) {
  /* Simple syntax highlighting for HTML/CSS/JS */
  let h = escapeHtml(code);
  h = h.replace(/(&lt;\/?[a-zA-Z][^&]*&gt;)/g, '<span style="color:#e879f9">$1</span>'); /* HTML tags */
  h = h.replace(/(\/\*[\s\S]*?\*\/|--[\s\S]*?$)/gm, '<span style="color:#6b7280">$1</span>'); /* Comments */
  h = h.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, '<span style="color:#f59e0b">$1</span>'); /* Strings */
  h = h.replace(/\b(function|const|let|var|if|else|return|class|import|export|default|async|await|for|while|do|switch|case|break|continue|new|this|typeof|instanceof)\b/g, '<span style="color:#3b82f6">$1</span>'); /* Keywords */
  h = h.replace(/\b(\d+\.?\d*)(px|rem|em|vh|vw|%|s|ms)?\b/g, '<span style="color:#22c55e">$1$2</span>'); /* Numbers + units */
  return h;
}

/* ── Init ── */
(async () => {
  /* Theme toggle - moved from inline script (CSP block) */
  const isDark = localStorage.getItem('theme') === 'dark';
  if (isDark) document.body.classList.add('dark');
  window.updateThemeIcon = () => {
    const icon = document.getElementById('theme-icon');
    if (icon) icon.textContent = document.body.classList.contains('dark') ? '☀️' : '🌙';
  };
  updateThemeIcon();
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      document.body.classList.toggle('dark');
      localStorage.setItem('theme', document.body.classList.contains('dark') ? 'dark' : 'light');
      updateThemeIcon();
    });
  }

  renderAgentCards();
  await renderChatList();
  newChat();
})();
