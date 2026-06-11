/* v2.1 — Production UI: 1s poll, robust reconnection, agent health */

const $ = id => document.getElementById(id.replace('#', ''));
let pollTimer = null, running = false, currentChatId = null, selectedAgents = [];
let projectFiles = {}, attachedFiles = [];
let pipelineStartTime = null, _lastOutputs = null;
let _reconnectAttempts = 0;

/* ── Settings ── */
const SETTINGS_KEY = 'orchestratorSettings';
const DEFAULT_SETTINGS = { retries:2, maxAgents:4, pollMs:1000, sound:true, notification:true, autoscroll:true, animSpeed:100 };
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try { const s = localStorage.getItem(SETTINGS_KEY); if (s) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(s) }; } catch {}
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}
function applySettingsUI() {
  ['retries','max-agents','poll-ms','sound','notification','autoscroll','anim-speed'].forEach(k => {
    const el = document.getElementById(`setting-${k}`);
    if (!el) return;
    const key = k.replace('-','');
    if (el.classList.contains('toggle-switch')) el.classList.toggle('on', !!settings[key]);
    else el.value = settings[key];
  });
}

/* ── Toast ── */
function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  t.style.cssText = `position:fixed;bottom:24px;right:24px;background:#1a1a2e;border:1px solid ${type==='error'?'#ef4444':'#10a37f'};border-radius:12px;padding:12px 20px;z-index:9999;color:white;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.5)`;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity 0.3s'; setTimeout(()=>t.remove(),300); }, 2700);
}

/* ── Agent strip ── */
function renderAgentCards() {
  const strip = $('#agent-strip');
  if (!strip) return;
  strip.innerHTML = '<span class="agent-strip-label">Agents:</span>';
  allActiveAgents().forEach(a => {
    const div = document.createElement('div');
    div.className = `agent-chip ${selectedAgents.includes(a.id) ? 'selected' : ''}`;
    div.dataset.agent = a.id;
    div.draggable = true;
    div.innerHTML = `<span>${a.icon}</span> ${a.name}<span class="dot" id="dot-${a.id}"></span><span class="health-indicator unknown" id="health-${a.id}"></span>`;
    div.addEventListener('click', () => {
      if (running) return;
      const idx = selectedAgents.indexOf(a.id);
      if (idx >= 0) selectedAgents.splice(idx, 1); else selectedAgents.push(a.id);
      renderAgentCards();
    });
    div.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', a.id); div.style.opacity='0.4'; });
    div.addEventListener('dragend', function() { this.style.opacity='1'; });
    div.addEventListener('dragover', e => e.preventDefault());
    div.addEventListener('drop', e => {
      e.preventDefault();
      const fromId = e.dataTransfer.getData('text/plain');
      if (fromId && fromId !== a.id) {
        const fi = selectedAgents.indexOf(fromId), ti = selectedAgents.indexOf(a.id);
        if (fi>=0 && ti>=0) { selectedAgents.splice(fi,1); selectedAgents.splice(ti,0,fromId); renderAgentCards(); }
      }
    });
    strip.appendChild(div);
  });
}
function highlightAgents(ids) {
  document.querySelectorAll('.agent-chip').forEach(c => c.classList.remove('selected'));
  ids.forEach(id => document.querySelector(`.agent-chip[data-agent="${id}"]`)?.classList.add('selected'));
}
function setAgentStatus(id, st) {
  const dot = $(`dot-${id}`);
  if (dot) dot.className = `dot ${st}`;
}
async function checkAgentHealth() {
  for (const a of allActiveAgents()) {
    const h = $(`health-${a.id}`);
    if (!h) continue;
    try {
      const tabs = await chrome.tabs.query({url: a.url + '*'});
      h.className = `health-indicator ${tabs.length > 0 ? 'online' : 'offline'}`;
    } catch { h.className = 'health-indicator unknown'; }
  }
}

/* ── Tasks ── */
function renderTasks(tasks, editable) {
  const c = $('#task-list');
  if (!tasks?.length) { $('#tasks-section')?.classList.add('hidden'); return; }
  $('#tasks-section')?.classList.remove('hidden');
  c.innerHTML = tasks.map((t,i) => `<div class="task-tile" style="${settings.animSpeed?`animation-delay:${i*40}ms`:''}">
    <div class="tile-num">#${i+1}</div>
    <div class="tile-body">
      <div class="tile-status ${t.status}">${t.status||'pending'}</div>
      <div class="tile-desc">${editable ? `<textarea data-index="${i}" class="tile-edit">${esc(t.description)}</textarea>` : esc(t.description)}</div>
      <div class="tile-agent">→ ${t.assignedTo||'unassigned'}</div>
      ${t.status==='error'?`<button class="retry-task" data-index="${i}" style="margin-top:6px;background:transparent;border:1px solid var(--danger);border-radius:40px;padding:4px 12px;font-size:0.7rem;cursor:pointer;color:var(--danger)">⟳ Retry</button>`:''}
      ${t.status==='in-progress'?`<button class="skip-task" data-index="${i}" style="margin-top:6px;margin-left:6px;background:transparent;border:1px solid var(--warning);border-radius:40px;padding:4px 12px;font-size:0.7rem;cursor:pointer;color:var(--warning)">⏭ Skip</button>`:''}
    </div>
  </div>`).join('');
}

/* ── Outputs ── */
function renderOutputs(ao) {
  _lastOutputs = ao;
  const c = $('#outputs-list');
  if (!ao||!Object.keys(ao).length) { $('#outputs-section')?.classList.add('hidden'); return; }
  $('#outputs-section')?.classList.remove('hidden');
  const total = Object.keys(ao).length, done = Object.values(ao).filter(d=>d.status==='done').length, err = Object.values(ao).filter(d=>d.status==='error').length;
  c.innerHTML = `
    <div class="outputs-summary">
      <span>${total} agents · ${done} done · ${err} errored</span>
      <button id="toggle-outputs" style="background:none;border:1px solid var(--border);border-radius:40px;padding:4px 14px;font-size:0.75rem;cursor:pointer;color:var(--text-secondary)">Show details</button>
    </div>
    <div id="outputs-detail" style="display:none">${Object.entries(ao).map(([id,data])=>{
      const a = getAgent(id); if(!a) return '';
      const badge = data.status==='streaming'?'⏳':data.status==='done'?'✅':data.status==='error'?'❌':'';
      const text = data.output||data.error||'Waiting...';
      return `<div class="output-card" style="animation-delay:${Object.keys(ao).indexOf(id)*50}ms">
        <div class="header"><span>${a.icon}</span> ${a.name} <span style="margin-left:auto">${badge}</span></div>
        <div class="body">${highlightSyntax(text)}</div>
        <button class="copy-output" data-text="${escAttr(text)}" style="margin-top:8px;background:transparent;border:1px solid var(--border);border-radius:20px;padding:4px 12px;font-size:11px;cursor:pointer;color:var(--text-secondary)">📋 Copy</button>
      </div>`;
    }).join('')}</div>`;
  const tg = document.getElementById('toggle-outputs');
  if (tg) tg.onclick = () => {
    const d = document.getElementById('outputs-detail');
    const h = d.style.display === 'none';
    d.style.display = h ? 'block' : 'none';
    tg.textContent = h ? 'Hide details' : 'Show details';
  };
  document.querySelectorAll('.copy-output').forEach(b => b.addEventListener('click', ()=>navigator.clipboard.writeText(b.dataset.text).then(()=>showToast('Copied!')).catch(()=>{})));
}

/* ── File extraction ── */
const FILE_RE = /<file\s+name=["']([^"']+)["']>([\s\S]*?)<\/file>/gi;
function syncFilesFromText(text) {
  if (!text) return;
  let changed = false, m;
  while ((m = FILE_RE.exec(text))) { const n=m[1].trim(),c=m[2].trim(); if(projectFiles[n]!==c){projectFiles[n]=c;changed=true;} }
  /* Also detect bare code blocks (```html, ```css, ```js) */
  const CODE_BLOCK = /```(\w+)\n([\s\S]*?)```/g;
  if (!changed) {
    let idx = 0;
    while ((m = CODE_BLOCK.exec(text)) && idx < 10) {
      const ext = m[1] === 'html' ? 'html' : m[1] === 'css' ? 'css' : m[1] === 'js' || m[1] === 'javascript' ? 'js' : m[1];
      const name = `output-${idx}.${ext}`;
      if (!projectFiles[name]) { projectFiles[name] = m[2].trim(); changed = true; idx++; }
    }
  }
  if (changed) renderFilePanel();
}
function syncFilesFromAI(ao) { if(!ao)return; for(const[,d]of Object.entries(ao))syncFilesFromText(d.output); }
function syncFilesFromSynthesis(t) { syncFilesFromText(t); }

/* ── File panel ── */
function renderFilePanel() {
  const names = Object.keys(projectFiles);
  if (!names.length) return;
  const old = document.getElementById('file-panel-output');
  if (old) old.remove();
  const content = $('content');
  if (!content) return;
  const panel = document.createElement('div'); panel.id = 'file-panel-output';
  panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <div style="font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--accent)">✅ Generated Files (${names.length})</div>
    <div class="file-tabs"><button class="file-tab active" data-view="grid">Grid</button><button class="file-tab" data-view="list">List</button></div>
  </div>
  <div class="file-grid" id="file-grid">${names.map(n=>{const e=n.split('.').pop();return `<div class="file-item" data-name="${escAttr(n)}">
    <span class="file-icon">${e==='html'?'🌐':e==='css'?'🎨':e==='js'?'⚡':e==='json'?'📋':e==='md'?'📝':'📄'}</span>
    <div class="file-info"><div class="file-name">${esc(n)}</div><div class="file-meta">${(projectFiles[n].length/1024).toFixed(1)}KB</div></div>
    <div class="file-actions">
      <button class="file-action-btn" data-action="copy" data-name="${escAttr(n)}">📋</button>
      <button class="file-action-btn" data-action="edit" data-name="${escAttr(n)}">✏️</button>
      <button class="file-action-btn" data-action="preview" data-name="${escAttr(n)}" ${n.endsWith('.html')?'':'style="display:none"'}>👁</button>
      <button class="file-action-btn" data-action="delete" data-name="${escAttr(n)}" style="color:var(--danger)">🗑</button>
    </div>
  </div>`;}).join('')}</div>
  <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
    <button id="download-zip-btn" style="background:var(--accent);color:white;border:none;border-radius:40px;padding:10px 24px;font-weight:600;cursor:pointer;font-size:0.85rem">⬇ Download (.zip)</button>
    <button id="preview-html-btn" style="background:transparent;color:var(--text);border:1px solid var(--border);border-radius:40px;padding:10px 24px;font-weight:500;cursor:pointer;font-size:0.85rem">👁 Preview HTML</button>
  </div>
  <div id="preview-container" style="display:none;margin-top:12px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;height:450px">
    <iframe id="preview-iframe" style="width:100%;height:100%;border:none;background:white"></iframe>
  </div>`;
  content.appendChild(panel);

  panel.querySelectorAll('.file-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      panel.querySelectorAll('.file-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('file-grid').className = tab.dataset.view === 'list' ? 'file-list' : 'file-grid';
    });
  });
  panel.querySelectorAll('.file-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.file-action-btn')) return;
      const n = item.dataset.name, c = projectFiles[n];
      if (!c) return;
      if (n.endsWith('.html') && confirm(`Preview ${n}?`)) {
        const ct = document.getElementById('preview-container'), f = document.getElementById('preview-iframe');
        if (!ct||!f) return;
        ct.style.display = ct.style.display==='block'?'none':'block';
        if (ct.style.display==='block') f.src = URL.createObjectURL(new Blob([c],{type:'text/html'}));
      } else { const s=window.open('','_blank','width=800,height=600'); if(s){s.document.write(`<pre style="font:14px monospace;padding:20px;background:#0a0c10;color:#eef1f5;white-space:pre-wrap">${esc(c)}</pre>`);s.document.close();} }
    });
  });
  panel.querySelectorAll('[data-action="copy"]').forEach(b => b.addEventListener('click', e=>{e.stopPropagation();navigator.clipboard.writeText(projectFiles[b.dataset.name]||'').then(()=>showToast('Copied!'));}));
  panel.querySelectorAll('[data-action="edit"]').forEach(b => b.addEventListener('click', e=>{e.stopPropagation();const n=b.dataset.name,c=projectFiles[n]||'',r=prompt(`Edit ${n}:`,c.substring(0,5000));if(r!==null){projectFiles[n]=r;showToast(`Saved ${n}`);renderFilePanel();}}));
  panel.querySelectorAll('[data-action="delete"]').forEach(b => b.addEventListener('click', e=>{e.stopPropagation();const n=b.dataset.name;if(confirm(`Delete ${n}?`)){delete projectFiles[n];renderFilePanel();showToast(`Deleted ${n}`);}}));

  document.getElementById('download-zip-btn')?.addEventListener('click', downloadZip);
  setTimeout(() => {
    document.getElementById('preview-html-btn')?.addEventListener('click', () => {
      const hf=Object.entries(projectFiles).find(([n])=>n.endsWith('.html')); if(!hf){showToast('No HTML','error');return;}
      const ct=document.getElementById('preview-container'), f=document.getElementById('preview-iframe');
      if(!ct||!f)return;
      if(ct.style.display==='block'){ct.style.display='none';document.getElementById('preview-html-btn').textContent='👁 Preview HTML';return;}
      f.src=URL.createObjectURL(new Blob([hf[1]],{type:'text/html'}));ct.style.display='block';document.getElementById('preview-html-btn').textContent='✕ Close';
    });
  }, 100);
}

function downloadZip() {
  const files = Object.entries(projectFiles).map(([n,c])=>({name:n,content:c}));
  if (!files.length) return showToast('No files','error');
  const enc = new TextEncoder();
  const parts = []; let offset = 0; const centralParts = [];
  for (const f of files) {
    const data = enc.encode(f.content), name = enc.encode(f.name);
    let crc = 0xffffffff;
    for (let i=0;i<data.length;i++){crc ^=data[i];for(let j=0;j<8;j++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
    crc = (crc^0xffffffff)>>>0;
    const sz=data.length, nl=name.length;
    const buf=new ArrayBuffer(30); const v=new DataView(buf);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0,true);v.setUint16(8,0,true);
    v.setUint16(10,0,true);v.setUint16(12,0,true);v.setUint32(14,crc,true);v.setUint32(18,sz,true);
    v.setUint32(22,sz,true);v.setUint16(26,nl,true);v.setUint16(28,0,true);
    parts.push(new Uint8Array(buf),name,data);
    const cbuf=new ArrayBuffer(46); const cv=new DataView(cbuf);
    cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);
    cv.setUint16(8,0,true);cv.setUint16(10,0,true);cv.setUint16(12,0,true);cv.setUint16(14,0,true);
    cv.setUint32(16,crc,true);cv.setUint32(20,sz,true);cv.setUint32(24,sz,true);
    cv.setUint16(28,nl,true);cv.setUint16(30,0,true);cv.setUint16(32,0,true);
    cv.setUint16(34,0,true);cv.setUint16(36,0,true);cv.setUint32(38,0,true);cv.setUint32(42,offset,true);
    centralParts.push({h:new Uint8Array(cbuf),name}); offset += 30+nl+sz;
  }
  let cs=0; for(const c of centralParts){parts.push(c.h,c.name);cs+=46+c.name.length;}
  const eocd=new ArrayBuffer(22); const ev=new DataView(eocd);
  ev.setUint32(0,0x06054b50,true);ev.setUint16(4,0,true);ev.setUint16(6,0,true);
  ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);
  ev.setUint32(12,cs,true);ev.setUint32(16,offset,true);ev.setUint16(20,0,true);
  parts.push(new Uint8Array(eocd));
  const total=parts.reduce((s,p)=>s+p.length,0), merged=new Uint8Array(total);
  let pos=0; for(const p of parts){merged.set(p,pos);pos+=p.length;}
  const blob=new Blob([merged],{type:'application/zip'}), url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url;
  const goalName=($('#goal-input').value||'project').substring(0,30).replace(/[^a-z0-9]/gi,'_').toLowerCase();
  a.download=`${goalName}-files.zip`; document.body.appendChild(a); a.click();
  setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},3000);
  showToast(`Downloaded ${goalName}-files.zip`);
}

/* ── Synthesis ── */
function renderSynthesis(text) {
  if (!text) { $('#synth-section')?.classList.add('hidden'); return; }
  /* Extract files from synthesis text first */
  syncFilesFromSynthesis(text);
  const fileCount = Object.keys(projectFiles).length;
  /* Strip prompt text — keep only content after the first <file> tag if files exist,
   * or strip lines that look like they're the prompt */
  let display = text;
  /* If files were extracted, show a clean summary instead of raw prompt+response */
  if (fileCount > 0) {
    display = `✅ Generated ${fileCount} file${fileCount > 1 ? 's' : ''} — scroll to the file panel below to preview and download.`;
  } else {
    /* Remove FILE_RE content and trim */
    display = text.replace(FILE_RE, '').trim();
    /* Also remove prompt-like leading lines (lines that start with 'Build the project' or 'Requirements from') */
    const lines = display.split('\n').filter(l => {
      const t = l.trim();
      return !t.startsWith('Build the project:') && 
             !t.startsWith('Requirements from specialists') &&
             !t.startsWith('Generate ONE') &&
             !t.startsWith('Wrap the file') &&
             !t.startsWith('Make it complete') &&
             t.length > 0;
    });
    display = lines.join('\n').trim();
  }
  $('#synth-section')?.classList.toggle('hidden', !display);
  const sb = $('#synth-body');
  if (sb) sb.textContent = display || '';
}

/* ── Export ── */
async function exportResults() {
  const goal = $('#goal-input').value||'Chat';
  const synth = $('#synth-body')?.textContent||'';
  let md = `# ${goal}\n\n${synth}\n\n`;
  for (const [n,c] of Object.entries(projectFiles)) md += `## ${n}\n\`\`\`\n${c}\n\`\`\`\n\n`;
  const b = new Blob([md],{type:'text/markdown'}), u=URL.createObjectURL(b);
  const a=document.createElement('a'); a.href=u; a.download='orchestrator.md'; a.click();
  URL.revokeObjectURL(u); showToast('Exported!');
}
async function exportHTML() {
  const goal = $('#goal-input').value||'Chat';
  let h = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(goal)}</title><style>body{font-family:system-ui;max-width:800px;margin:auto;padding:20px;line-height:1.6}</style></head><body><h1>${esc(goal)}</h1><p><em>The Orchestrator</em></p><hr>`;
  for (const [n,c] of Object.entries(projectFiles)) h += `<h2>${esc(n)}</h2><pre style="background:#f5f5f5;padding:12px;border-radius:8px;overflow:auto"><code>${esc(c)}</code></pre>`;
  h += '</body></html>';
  const b = new Blob([h],{type:'text/html'}), u=URL.createObjectURL(b);
  const a=document.createElement('a'); a.href=u; a.download='orchestrator-export.html'; a.click();
  URL.revokeObjectURL(u); showToast('Exported as HTML');
}
$('#export-btn')?.addEventListener('click', exportResults);
$('#export-html-btn')?.addEventListener('click', exportHTML);

/* ── Sound ── */
function playBeep() {
  try { const ctx=new (window.AudioContext||window.webkitAudioContext)(), osc=ctx.createOscillator(), gain=ctx.createGain(); osc.connect(gain); gain.connect(ctx.destination); osc.frequency.value=880; gain.gain.value=0.1; osc.start(); osc.stop(ctx.currentTime+0.15); } catch {}
}

/* ── Confetti ── */
function fireConfetti() {
  const c=document.createElement('div'); c.className='confetti-container';
  const colors=['#10a37f','#3b82f6','#f59e0b','#ef4444','#8b5cf6','#ec4899'];
  for(let i=0;i<60;i++){const p=document.createElement('div');p.className='confetti-piece';p.style.cssText=`left:${Math.random()*100}%;top:-${Math.random()*20}px;background:${colors[i%colors.length]};width:${6+Math.random()*8}px;height:${6+Math.random()*8}px;animation-delay:${Math.random()*0.8}s;animation-duration:${2+Math.random()*2}s;border-radius:${Math.random()>0.5?'50%':'2px'}`;c.appendChild(p);}
  document.body.appendChild(c); setTimeout(()=>c.remove(),4000);
}

/* ── Pipeline flow ── */
function updatePipelineFlow(state) {
  const n=['flow-plan','flow-brain','flow-execute','flow-review','flow-synth'];
  n.forEach(id=>{const e=document.getElementById(id);if(e)e.classList.remove('active','done');});
  const m={'login-check':'flow-plan','planning':'flow-plan','confirm-tasks':'flow-plan','running':'flow-execute','brain-writing':'flow-brain','brain-executing':'flow-execute','brain-reviewing':'flow-review','synthesis':'flow-synth','done':'flow-synth','error':'flow-synth'};
  const a=m[state.step]; if(a){const e=document.getElementById(a);if(e)e.classList.add(state.step==='done'?'done':'active');const i=n.indexOf(a);for(let j=0;j<i;j++){const e=document.getElementById(n[j]);if(e)e.classList.add('done');}}
  const bl=document.getElementById('flow-brain-label'); if(bl&&state.brainPhase){const m=state.brainPhase.match(/(DeepSeek|ChatGPT|Gemini|Perplexity|HuggingFace)/);if(m)bl.textContent=m[0];}
}

/* ── Status ── */
function statusText(state) {
  const m={'login-check':'Checking logins...','planning':'Planning tasks...','confirm-tasks':'Review and confirm','running':`Executing (${state.tasks?.filter(t=>t.status==='done').length||0}/${state.tasks?.length||0})`,'synthesis':'Synthesizing...','done':'Complete!','error':`Error: ${state.error||''}`};
  return m[state.step]||state.step||'Ready';
}

function render(state) {
  const dot = $('#status-dot');
  const active = ['login-check','planning','confirm-tasks','running','synthesis'].includes(state.step);
  dot.className = `status-dot ${active?'working':state.step==='done'?'done':state.step==='error'?'error':''}`;
  $('#status-text').textContent = statusText(state);
  const badge = $('#status-badge');
  if (badge) { badge.textContent=statusText(state); badge.className=`pipeline-status-badge ${active?'running':state.step==='done'?'done':state.step==='error'?'error':''}`; }

  const pd = $('#pipeline-display');
  const isRunning = ['running','brain-writing','brain-executing','brain-reviewing','synthesis'].includes(state.step);
  if (isRunning) {
    pd.classList.add('active');
    updatePipelineFlow(state);
    const total=state.tasks?.length||0, done=state.tasks?.filter(t=>t.status==='done'||t.status==='error').length||0;
    $('#pd-progress-text').textContent = `Task ${done} of ${total}`;
    $('#pd-progress-fill').style.width = total>0?`${(done/total)*100}%`:'0%';
    if (pipelineStartTime && done>0) {
      const e=(Date.now()-pipelineStartTime)/1000, avg=e/done, r=Math.round(avg*(total-done));
      $('#pd-time').textContent = `${e>60?Math.round(e/60)+'m':Math.round(e)+'s'} · ~${r>60?Math.round(r/60)+'m':Math.round(r)+'s'} remaining`;
    }
  } else { pd.classList.remove('active'); }

  renderTasks(state.tasks, state.step==='confirm-tasks');
  if (['running','brain-writing','brain-executing','brain-reviewing','synthesis','done'].includes(state.step)) syncFilesFromAI(state.agentOutputs);
  renderOutputs(state.agentOutputs);
  renderSynthesis(state.synthesis);
  if (Object.keys(projectFiles).length>0) renderFilePanel();

  $('#confirm-bar').style.display = state.step==='confirm-tasks'?'flex':'none';
  if (state.selectedAgents) highlightAgents(state.selectedAgents);

  const ee = $('#status-elapsed');
  if (pipelineStartTime && isRunning) {
    const s = Math.round((Date.now()-pipelineStartTime)/1000);
    ee.textContent = s>60?`${Math.floor(s/60)}m ${s%60}s`:`${s}s`;
  } else { ee.textContent = ''; }

  if (['done','error','cancelled'].includes(state.step)) {
    running = false; _reconnectAttempts = 0;
    $('#run-btn').classList.remove('hidden'); $('#stop-btn').classList.add('hidden');
    stopPoll();
    if (Object.keys(projectFiles).length>0) { renderFilePanel(); if(settings.autoscroll)setTimeout(()=>{const fp=document.getElementById('file-panel-output');if(fp)fp.scrollIntoView({behavior:'smooth',block:'center'});},300); }
    if (currentChatId && Object.keys(projectFiles).length>0) {
      getChat(currentChatId).then(chat => { if(chat){chat.projectFiles={...projectFiles};saveChat(chat);} });
    }
    if (state.step==='done') {
      showToast('✅ Pipeline complete!'); fireConfetti();
      if (settings.sound) playBeep();
      if (settings.notification) {
        if (Notification.permission==='granted') new Notification('The Orchestrator',{body:'✅ Pipeline completed!',icon:'../icons/icon128.png'});
        else if (Notification.permission!=='denied') Notification.requestPermission();
      }
    } else if (state.step==='error') showToast('❌ '+ (state.error||'Pipeline failed'), 'error');
  }
}

/* ── Polling (1s interval) ── */
async function fetchState() {
  try {
    const s = await chrome.runtime.sendMessage({action:'multiStatus'});
    if (s) {
      _reconnectAttempts = 0;
      render(s);
      if (['running','brain-writing','brain-executing','brain-reviewing','synthesis'].includes(s.step))
        sessionStorage.setItem('pipelineState',JSON.stringify({step:s.step,projectFiles}));
    } else if (running) {
      /* State missing — try to reconnect */
      _reconnectAttempts++;
      if (_reconnectAttempts > 30) { /* 30 seconds without state */
        showToast('⚠️ Lost connection to pipeline. Reload to restart.','error');
        running=false; stopPoll();
        $('#run-btn').classList.remove('hidden'); $('#stop-btn').classList.add('hidden');
      }
    }
  } catch { if (running) _reconnectAttempts++; }
}
function startPoll() { stopPoll(); pollTimer=setInterval(fetchState, settings.pollMs||1000); }
function stopPoll() { if(pollTimer) clearInterval(pollTimer); }

/* ── Templates ── */
$('#template-select')?.addEventListener('change', e => { if(e.target.value){$('#goal-input').value=e.target.value;e.target.value='';} });

/* ── Files ── */
const dropArea = document.getElementById('goal-input')?.parentElement;
if (dropArea) {
  dropArea.addEventListener('dragover', e=>{e.preventDefault();dropArea.style.opacity='0.7';});
  dropArea.addEventListener('dragleave', ()=>{dropArea.style.opacity='1';});
  dropArea.addEventListener('drop', async e => { e.preventDefault();dropArea.style.opacity='1';
    for(const f of Array.from(e.dataTransfer.files)){const c=f.type.startsWith('text/')||/\.(js|html|css|json|md|txt)$/i.test(f.name)?await f.text():`[Binary: ${f.name} - ${f.size} bytes]`;attachedFiles.push({name:f.name,content:c});}
    $('#file-count').textContent=`${attachedFiles.length} file(s)`;
    const g=$('#goal-input'); if(attachedFiles.length&&!g.value.includes('Attached files:'))g.value+=`\n\nAttached files:\n${attachedFiles.map(f=>`--- ${f.name} ---\n${f.content.slice(0,1500)}`).join('\n')}`;
  });
}
$('#file-upload')?.addEventListener('change', async e => {
  for(const f of Array.from(e.target.files)){const c=f.type.startsWith('text/')||f.name.endsWith('.js')||f.name.endsWith('.html')||f.name.endsWith('.css')||f.name.endsWith('.json')||f.name.endsWith('.md')?await f.text():`[Binary: ${f.name} - ${f.size} bytes]`;attachedFiles.push({name:f.name,content:c});}
  $('#file-count').textContent=`${attachedFiles.length} file(s)`;
  const g=$('#goal-input'); if(attachedFiles.length&&!g.value.includes('Attached files:'))g.value+=`\n\nAttached files:\n${attachedFiles.map(f=>`--- ${f.name} ---\n${f.content.slice(0,1500)}`).join('\n')}`;
  e.target.value='';
});

/* ── Chat history ── */
async function renderChatList(filter) {
  const chats = await listChats();
  const list = $('#chat-list'); if(!list) return;
  const si = list.querySelector('#chat-search'); list.innerHTML='';
  if (si) list.appendChild(si);
  (filter?chats.filter(c=>(c.title||'').toLowerCase().includes(filter.toLowerCase())):chats).forEach(c=>{
    const d=document.createElement('div');
    d.className=`chat-item ${c.id===currentChatId?'active':''}`; d.dataset.id=c.id;
    d.innerHTML=`<div class="chat-title">${esc(c.title)}</div><div class="chat-meta"><span>${new Date(c.timestamp).toLocaleDateString()}</span><button class="del-chat" data-id="${c.id}" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:16px;opacity:0.6">×</button></div>`;
    list.appendChild(d);
  });
  list.querySelectorAll('.chat-item').forEach(el => {
    el.addEventListener('click', e => { if(!e.target.classList.contains('del-chat'))selectChat(el.dataset.id); });
    el.querySelector('.del-chat')?.addEventListener('click', async e => { e.stopPropagation(); if(!confirm('Delete this chat?'))return; await deleteChat(el.dataset.id); if(currentChatId===el.dataset.id)newChat(); renderChatList(document.getElementById('chat-search')?.value); });
  });
  if (si) si.oninput = () => renderChatList(si.value);
}

async function selectChat(id) {
  const chat = await getChat(id);
  if (!chat) return;
  currentChatId = id;
  $('#goal-input').value = chat.prompt||'';
  if (chat.results) {
    renderTasks(chat.results.tasks);
    renderOutputs(chat.results.agentOutputs);
    renderSynthesis(chat.results.synthesis);
    if (chat.projectFiles) { projectFiles={...chat.projectFiles}; renderFilePanel(); }
  }
  if (chat.selectedAgents) highlightAgents(chat.selectedAgents);
  renderChatList();
}
function newChat() {
  currentChatId=null; selectedAgents=[]; projectFiles={};
  $('#goal-input').value=''; $('#status-text').textContent='Ready'; $('#status-dot').className='status-dot';
  ['tasks-section','outputs-section','synth-section'].forEach(s=>$(s)?.classList.add('hidden'));
  const fp=document.getElementById('file-panel-output'); if(fp)fp.remove();
  renderAgentCards(); renderChatList();
  const badge=$('#status-badge'); if(badge){badge.textContent='Pipeline ready';badge.className='pipeline-status-badge';}
}
$('#new-chat-btn')?.addEventListener('click', newChat);

/* ── Run / Stop ── */
$('#run-btn').addEventListener('click', async () => {
  if (running) return;
  const goal = $('#goal-input').value.trim();
  if (!goal) { showToast('Enter a goal first','error'); return; }
  running = true; _reconnectAttempts = 0; pipelineStartTime = Date.now();
  projectFiles = {};
  const oldFp = document.getElementById('file-panel-output'); if (oldFp) oldFp.remove();
  attachedFiles = [];
  try { localStorage.setItem('lastGoal', goal); } catch {}
  $('#run-btn').classList.add('hidden'); $('#stop-btn').classList.remove('hidden');
  $('#status-dot').className = 'status-dot working'; $('#status-text').textContent = 'Starting...';
  startPoll();

  if (!currentChatId) {
    const chat = await createChat(goal);
    currentChatId = chat.id; await saveChat(chat);
  }
  await renderChatList();
  allActiveAgents().forEach(a => setAgentStatus(a.id,'idle'));

  chrome.runtime.sendMessage({ action:'runMulti', goal,
    selectedAgents: selectedAgents.length ? selectedAgents : null,
    chatId: currentChatId, projectFiles,
  });
});
$('#stop-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({action:'stopMulti'});
  running=false; _reconnectAttempts=0; $('#run-btn').classList.remove('hidden'); $('#stop-btn').classList.add('hidden');
  stopPoll(); $('#status-text').textContent='Cancelled'; $('#status-dot').className='status-dot error';
  showToast('Cancelled','error');
});
$('#confirm-tasks')?.addEventListener('click', () => chrome.runtime.sendMessage({action:'confirmTasks'}));
$('#cancel-tasks')?.addEventListener('click', () => chrome.runtime.sendMessage({action:'rejectTasks'}));

document.addEventListener('click', e => {
  const r=e.target.closest('.retry-task'), s=e.target.closest('.skip-task');
  if (r){chrome.runtime.sendMessage({action:'retryTask',taskIndex:parseInt(r.dataset.index)});showToast('Retrying...');}
  if (s){chrome.runtime.sendMessage({action:'skipTask',taskIndex:parseInt(s.dataset.index)});showToast('Skipping...');}
});

/* ── Shortcuts ── */
document.addEventListener('keydown', e => {
  if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!running) $('#run-btn')?.click();
  if(e.key==='Escape'&&running) $('#stop-btn')?.click();
  if(e.key==='?'&&!e.ctrlKey&&!e.metaKey){e.preventDefault();toggleShortcuts();}
  if(e.key==='n'&&(e.ctrlKey||e.metaKey)){e.preventDefault();newChat();}
});

let shortcutsOpen = false;
function toggleShortcuts() {
  shortcutsOpen=!shortcutsOpen;
  const ex=document.querySelector('.shortcuts-modal');
  if(ex){ex.remove();shortcutsOpen=false;return;}
  if(!shortcutsOpen)return;
  const m=document.createElement('div'); m.className='shortcuts-modal';
  m.innerHTML=`<div class="shortcuts-content"><h2>⌨️ Shortcuts <button id="close-shortcuts" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text-secondary)">✕</button></h2>
    ${[['Ctrl+Enter','Run'],['Esc','Stop'],['Ctrl+N','New chat'],['?','Shortcuts'],['G','Settings']].map(([k,d])=>`<div class="shortcut-row"><span class="shortcut-key">${k}</span><span class="shortcut-desc">${d}</span></div>`).join('')}</div>`;
  document.body.appendChild(m);
  m.querySelector('#close-shortcuts')?.addEventListener('click',()=>{m.remove();shortcutsOpen=false;});
  m.addEventListener('click',e=>{if(e.target===m){m.remove();shortcutsOpen=false;}});
}
$('#shortcuts-btn')?.addEventListener('click', toggleShortcuts);

/* ── Settings ── */
let settingsOpen = false;
function toggleSettings() {
  settingsOpen=!settingsOpen;
  document.getElementById('settings-panel')?.classList.toggle('open',settingsOpen);
  document.getElementById('settings-overlay')?.classList.toggle('hidden',!settingsOpen);
}
$('#settings-btn')?.addEventListener('click', toggleSettings);
$('#settings-close')?.addEventListener('click', toggleSettings);
$('#settings-overlay')?.addEventListener('click', toggleSettings);

function initSettings() {
  loadSettings(); applySettingsUI();
  const bindToggle=(id,key)=>{const el=document.getElementById(id);if(!el)return;el.addEventListener('click',()=>{settings[key]=!settings[key];el.classList.toggle('on');saveSettings();});};
  bindToggle('setting-sound','sound'); bindToggle('setting-notification','notification'); bindToggle('setting-autoscroll','autoscroll');
  ['retries','max-agents','poll-ms','anim-speed'].forEach(k=>{const el=document.getElementById(`setting-${k}`);if(!el)return;el.addEventListener('change',()=>{settings[k.replace('-','')]=parseInt(el.value);saveSettings();});});
  $('#settings-reset')?.addEventListener('click',()=>{if(!confirm('Reset settings?'))return;settings={...DEFAULT_SETTINGS};saveSettings();applySettingsUI();showToast('Reset');});
}

/* ── Auto-update ── */
let _updateSha = '', _updateMsg = '';
let _updating = false;

async function checkUpdate() {
  try {
    const r = await chrome.runtime.sendMessage({ action: 'checkUpdate' });
    if (r?.available && r?.latestSha) {
      _updateSha = r.latestSha;
      _updateMsg = r.commitMsg || 'Update available';
      const btn = document.getElementById('update-btn');
      if (btn) { btn.style.display = ''; btn.title = _updateMsg; }
    }
  } catch {}
}

function toggleUpdatePanel(show) {
  const panel = document.getElementById('update-panel');
  const overlay = document.getElementById('update-overlay');
  if (!panel || !overlay) return;
  panel.style.bottom = show ? '0' : '-450px';
  overlay.classList.toggle('hidden', !show);
  if (!show) { _updating = false; return; }
  /* Reset panel */
  document.getElementById('update-progress').style.display = 'none';
  document.getElementById('update-progress-fill').style.width = '0%';
  ['update-instructions','update-reload-btn','update-open-folder','update-open-ext'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  const dlBtn = document.getElementById('update-download-btn');
  if (dlBtn) { dlBtn.style.display = ''; dlBtn.textContent = '⬇ Download Update'; }
  const msg = document.getElementById('update-message');
  if (msg) msg.innerHTML = _updateMsg ? `📢 <strong>${_updateMsg}</strong>` : 'A new version is available on GitHub.';
}

async function doUpdate() {
  if (_updating) return;
  _updating = true;
  const dlBtn = document.getElementById('update-download-btn');
  const prog = document.getElementById('update-progress');
  const progText = document.getElementById('update-progress-text');
  const progFill = document.getElementById('update-progress-fill');
  if (dlBtn) dlBtn.style.display = 'none';
  if (prog) prog.style.display = '';
  if (progText) progText.textContent = '⬇ Downloading...';
  if (progFill) progFill.style.width = '30%';

  try {
    const r = await chrome.runtime.sendMessage({ action: 'downloadUpdate' });
    if (r?.success) {
      if (progFill) progFill.style.width = '100%';
      if (progText) progText.textContent = '✅ Downloaded!';
      /* Show step-by-step with helper buttons */
      ['update-instructions','update-reload-btn','update-open-folder','update-open-ext'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = '';
      });
      if (_updateSha) {
        await chrome.runtime.sendMessage({ action: 'acknowledgeUpdate', sha: _updateSha });
        const btn = document.getElementById('update-btn');
        if (btn) btn.style.display = 'none';
      }
    } else {
      throw new Error(r?.error || 'Download failed');
    }
  } catch (err) {
    if (progText) progText.textContent = `❌ ${err.message}`;
    if (dlBtn) { dlBtn.style.display = ''; dlBtn.textContent = '⬇ Retry'; }
  }
  _updating = false;
}

function reloadExtension() {
  if (confirm('Ready to update?\n\n1️⃣ Extract the ZIP to replace your extension folder\n2️⃣ Click OK to reload from the new files')) {
    chrome.runtime.reload();
  }
}

$('#update-btn')?.addEventListener('click', () => toggleUpdatePanel(true));
$('#update-close')?.addEventListener('click', () => toggleUpdatePanel(false));
$('#update-overlay')?.addEventListener('click', () => toggleUpdatePanel(false));
$('#update-download-btn')?.addEventListener('click', doUpdate);
$('#update-reload-btn')?.addEventListener('click', reloadExtension);
const uf = document.getElementById('update-open-folder');
if (uf) {
  uf.querySelectorAll('button').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: i === 0 ? 'openDownloads' : 'openExtensions' });
    });
  });
}
$('#update-skip-btn')?.addEventListener('click', () => {
  toggleUpdatePanel(false);
  if (_updateSha) chrome.runtime.sendMessage({ action: 'acknowledgeUpdate', sha: _updateSha });
  const btn = document.getElementById('update-btn');
  if (btn) btn.style.display = 'none';
});

/* ── Utilities ── */
function esc(s){return String(s).replace(/[&<>]/g,m=>m==='&'?'&amp;':m==='<'?'&lt;':'&gt;');}
function escAttr(s){return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');}
function highlightSyntax(code) {
  let h=esc(code);
  h=h.replace(/(&lt;\/?[a-zA-Z][^&]*&gt;)/g,'<span style="color:#e879f9">$1</span>');
  h=h.replace(/(\/\*[\s\S]*?\*\/|--[\s\S]*?$)/gm,'<span style="color:#6b7280">$1</span>');
  h=h.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,'<span style="color:#f59e0b">$1</span>');
  h=h.replace(/\b(function|const|let|var|if|else|return|class|import|export|default|async|await|for|while|do|switch|case|break|continue|new|this|typeof|instanceof)\b/g,'<span style="color:#3b82f6">$1</span>');
  h=h.replace(/\b(\d+\.?\d*)(px|rem|em|vh|vw|%|s|ms)?\b/g,'<span style="color:#22c55e">$1$2</span>');
  return h;
}

/* ── Init ── */
(async () => {
  const isDark = localStorage.getItem('theme')==='dark';
  if (isDark) document.body.classList.add('dark');
  window.updateThemeIcon = () => { const i=document.getElementById('theme-icon'); if(i)i.textContent=document.body.classList.contains('dark')?'☀️':'🌙'; };
  updateThemeIcon();
  $('#theme-toggle')?.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('theme', document.body.classList.contains('dark')?'dark':'light');
    updateThemeIcon();
  });

  /* Recover pipeline state */
  const saved = sessionStorage.getItem('pipelineState');
  if (saved) {
    try {
      const p = JSON.parse(saved);
      if (p.projectFiles) projectFiles = p.projectFiles;
      if (p.step&&['running','brain-writing','brain-executing','brain-reviewing','synthesis'].includes(p.step)) {
        showToast('🔄 Reconnecting...'); startPoll();
      }
      sessionStorage.removeItem('pipelineState');
    } catch {}
  }

  try { const g = localStorage.getItem('lastGoal'); if (g&&!$('#goal-input').value) $('#goal-input').value=g; } catch {}
  $('#goal-input')?.addEventListener('input', () => { try { localStorage.setItem('lastGoal',$('#goal-input').value); } catch {} });

  document.body.style.opacity='0';
  requestAnimationFrame(() => { document.body.style.transition='opacity 0.3s'; document.body.style.opacity='1'; });

  initSettings();
  renderAgentCards();
  await renderChatList();
  newChat();
  checkAgentHealth();
  setInterval(checkAgentHealth, 30000);
  /* Check for updates on startup + every 6 hours */
  checkUpdate();
  setInterval(checkUpdate, 6 * 60 * 60 * 1000);
})();
