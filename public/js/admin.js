async function api(path, options = {}) {
  const base = window.ASKBACK_BASE || '';
  const res = await fetch(`${base}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderStats(s) {
  const el = document.getElementById('stats-grid');
  const botOn = s.botMode !== 'off';
  const privateOn = s.privateChats !== 'off';
  el.innerHTML = [
    ['QA answers', s.totalQA],
    ['Today', s.todayQA],
    ['Documents', s.totalDocs],
    ['Chunks', s.totalChunks],
    ['Bot', botOn ? 'On' : 'Off'],
    ['Private', privateOn ? 'On' : 'Off'],
    ['Voice', prettyVoice(s)],
  ]
    .map(
      ([label, value]) =>
        `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${label}</span></div>`
    )
    .join('');

  setBotToggle(botOn);
  setPrivateChatsToggle(privateOn);
  setDailyDigestToggle(s.dailyDigest !== 'off');
  setDeadlineRemindersToggle(s.deadlineReminders !== 'off');
  setMeetingSummariesToggle(s.meetingSummaries !== 'off');
  setRepeatNudgeToggle(s.repeatNudge !== 'off');
  setShowSourcesToggle(s.showSources !== 'off');
}

function prettyVoice(s) {
  const id = String(s?.lemonfoxVoice || '').trim();
  const match = (s?.lemonfoxVoices || []).find((v) => v.id === id);
  return match?.label || id || 'Sarah';
}

function fillVoiceSelect(s) {
  const select = document.getElementById('tts-voice');
  if (!select) return;
  const voices = s?.lemonfoxVoices || [];
  const current = String(s?.lemonfoxVoice || '').trim();
  const groups = [];
  for (const voice of voices) {
    let group = groups.find((g) => g.label === voice.group);
    if (!group) {
      group = { label: voice.group, options: [] };
      groups.push(group);
    }
    group.options.push(voice);
  }
  select.innerHTML = groups
    .map(
      (group) =>
        `<optgroup label="${escapeHtml(group.label)}">${group.options
          .map(
            (voice) =>
              `<option value="${escapeHtml(voice.id)}"${voice.id === current ? ' selected' : ''}>${escapeHtml(
                voice.label
              )}</option>`
          )
          .join('')}</optgroup>`
    )
    .join('');
}

function renderWhatsAppPair(state) {
  const el = document.getElementById('wa-pair');
  if (!el) return;
  const base = window.ASKBACK_BASE || '';
  if (state?.connected) {
    const phone = String(state.phone || '').replace(/[^\d]/g, '');
    el.innerHTML = `
      <p class="hint">${
        phone
          ? `WhatsApp is connected as <strong>+${escapeHtml(phone)}</strong>. askBack is ready.`
          : 'WhatsApp is connected. askBack is ready.'
      }</p>
      <button type="button" class="ghost" data-action="re-pair">Change number</button>
    `;
    return;
  }
  if (state?.hasQr) {
    el.innerHTML = `
      <p class="hint">Scan this QR in WhatsApp → Linked Devices. It refreshes on its own.</p>
      <img src="${base}/whatsapp-qr.png?t=${Date.now()}" alt="WhatsApp pairing QR code" width="320" height="320" />
    `;
    return;
  }
  el.innerHTML = state?.pairing
    ? '<p class="hint">Preparing a QR code to pair a new number…</p>'
    : '<p class="hint">Waiting for a WhatsApp QR code…</p>';
}

async function refreshWhatsAppPair() {
  try {
    renderWhatsAppPair(await api('/api/whatsapp'));
  } catch (err) {
    const el = document.getElementById('wa-pair');
    if (el) el.innerHTML = `<p class="hint"><span class="error">${escapeHtml(err.message)}</span></p>`;
  }
}

document.getElementById('wa-pair')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="re-pair"]');
  if (!btn) return;
  if (
    !confirm(
      'Disconnect this WhatsApp number? A QR code will appear so you can pair a different number.'
    )
  ) {
    return;
  }
  btn.disabled = true;
  renderWhatsAppPair({ pairing: true });
  try {
    renderWhatsAppPair(await api('/api/whatsapp/re-pair', { method: 'POST' }));
  } catch (err) {
    const el = document.getElementById('wa-pair');
    if (el) el.innerHTML = `<p class="hint"><span class="error">${escapeHtml(err.message)}</span></p>`;
  }
});

function setBotToggle(on) {
  const btn = document.getElementById('bot-toggle');
  btn.setAttribute('aria-checked', String(on));
  btn.disabled = false;
}

function setPrivateChatsToggle(on) {
  const btn = document.getElementById('private-chats-toggle');
  const meta = document.getElementById('private-chats-meta');
  if (btn) {
    btn.setAttribute('aria-checked', String(on));
    btn.disabled = false;
  }
  if (meta) {
    meta.textContent = on ? 'Answering in one-to-one chats' : 'Silent in one-to-one chats';
  }
}

function setDailyDigestToggle(on) {
  const btn = document.getElementById('daily-digest-toggle');
  const meta = document.getElementById('daily-digest-meta');
  if (btn) {
    btn.setAttribute('aria-checked', String(on));
    btn.disabled = false;
  }
  if (meta) {
    meta.textContent = on
      ? 'Every day at 5:00 CAT: yesterday recap + today deadlines'
      : 'Daily briefing is off';
  }
}

function setDeadlineRemindersToggle(on) {
  const btn = document.getElementById('deadline-reminders-toggle');
  const meta = document.getElementById('deadline-reminders-meta');
  if (btn) {
    btn.setAttribute('aria-checked', String(on));
    btn.disabled = false;
  }
  if (meta) {
    meta.textContent = on
      ? 'Ping enabled groups 30 minutes before deadlines or scheduled items'
      : 'Deadline reminders are off';
  }
}

function setMeetingSummariesToggle(on) {
  const btn = document.getElementById('meeting-summaries-toggle');
  const meta = document.getElementById('meeting-summaries-meta');
  if (btn) {
    btn.setAttribute('aria-checked', String(on));
    btn.disabled = false;
  }
  if (meta) {
    meta.textContent = on
      ? 'Auto-summarize uploaded call and meeting recordings'
      : 'Meeting summaries are off';
  }
}

function setRepeatNudgeToggle(on) {
  const btn = document.getElementById('repeat-nudge-toggle');
  const meta = document.getElementById('repeat-nudge-meta');
  if (btn) {
    btn.setAttribute('aria-checked', String(on));
    btn.disabled = false;
  }
  if (meta) {
    meta.textContent = on
      ? 'Say when a question was already answered before'
      : 'Already-answered note is off';
  }
}

function setShowSourcesToggle(on) {
  const btn = document.getElementById('show-sources-toggle');
  const meta = document.getElementById('show-sources-meta');
  if (btn) {
    btn.setAttribute('aria-checked', String(on));
    btn.disabled = false;
  }
  if (meta) {
    meta.textContent = on
      ? 'Add a one-line source note to answers from a file'
      : 'Source notes are off';
  }
}

const DOCS_FIRST_PAGE = 3;
const DOCS_PAGE_SIZE = 10;
let docsCache = [];
let docsPage = 1;

const QA_PAGE_SIZE = 5;
let qaCache = [];
let qaPage = 1;

const STICKERS_PAGE_SIZE = 10;
let stickersCache = [];
let stickersPage = 1;

function docsTotalPages(count) {
  if (count <= DOCS_FIRST_PAGE) return 1;
  return 1 + Math.ceil((count - DOCS_FIRST_PAGE) / DOCS_PAGE_SIZE);
}

function docsPageSlice(docs, page) {
  const total = docsTotalPages(docs.length);
  const safe = Math.min(Math.max(1, page), total);
  if (safe <= 1) return docs.slice(0, DOCS_FIRST_PAGE);
  const start = DOCS_FIRST_PAGE + (safe - 2) * DOCS_PAGE_SIZE;
  return docs.slice(start, start + DOCS_PAGE_SIZE);
}

function docsRangeLabel(docs, page) {
  const total = docs.length;
  if (!total) return '';
  if (page <= 1) {
    const end = Math.min(DOCS_FIRST_PAGE, total);
    return `1–${end} of ${total}`;
  }
  const start = DOCS_FIRST_PAGE + (page - 2) * DOCS_PAGE_SIZE + 1;
  const end = Math.min(start + DOCS_PAGE_SIZE - 1, total);
  return `${start}–${end} of ${total}`;
}

function renderDocsPager() {
  const pager = document.getElementById('docs-pager');
  if (!pager) return;
  const totalPages = docsTotalPages(docsCache.length);
  if (docsCache.length <= DOCS_FIRST_PAGE) {
    pager.hidden = true;
    pager.innerHTML = '';
    return;
  }
  pager.hidden = false;
  pager.innerHTML = `
    <p class="pager-meta">${escapeHtml(docsRangeLabel(docsCache, docsPage))}</p>
    <div class="pager-actions">
      <button type="button" class="ghost" data-docs-page="prev" ${docsPage <= 1 ? 'disabled' : ''}>Prev</button>
      <span class="pager-meta">Page ${docsPage} / ${totalPages}</span>
      <button type="button" class="ghost" data-docs-page="next" ${docsPage >= totalPages ? 'disabled' : ''}>Next</button>
    </div>
  `;
}

function renderDocs(docs) {
  const el = document.getElementById('docs');
  docsCache = Array.isArray(docs) ? docs : [];
  const totalPages = docsTotalPages(docsCache.length);
  if (docsPage > totalPages) docsPage = totalPages;
  if (docsPage < 1) docsPage = 1;

  if (!docsCache.length) {
    el.innerHTML = '<li class="meta">No files yet. Add a WhatsApp .txt export, PDF, or audio recording above.</li>';
    renderDocsPager();
    return;
  }

  const pageDocs = docsPageSlice(docsCache, docsPage);
  el.innerHTML = pageDocs
    .map(
      (d) => `
      <li class="file-item" data-id="${d.id}" data-title="${escapeHtml(d.title || d.filename)}" data-filename="${escapeHtml(d.filename)}">
        <h3>${escapeHtml(d.title || d.filename)}</h3>
        <p class="meta">
          ${escapeHtml(d.filename)}
          · ${escapeHtml(d.type)} · ${escapeHtml(d.status)}
          ${d.chunk_count ? ` · ${d.chunk_count} chunks` : ''}
          ${d.sharable ? ' · can send in WhatsApp if asked' : d.downloadable ? ' · used for answers only' : ' · re-upload to keep a copy'}
          ${d.error ? ` · <span class="error">${escapeHtml(d.error)}</span>` : ''}
          · ${escapeHtml(d.created_at)}
        </p>
        <div class="file-actions">
          ${d.viewable ? '<button type="button" class="ghost" data-action="view">View</button>' : ''}
          <button type="button" class="ghost" data-action="edit">Edit</button>
          ${d.downloadable ? '<button type="button" class="ghost" data-action="download">Download</button>' : ''}
          <button type="button" class="danger" data-action="delete">Delete</button>
        </div>
      </li>`
    )
    .join('');
  renderDocsPager();
}

function renderStickers(stickers) {
  const el = document.getElementById('stickers');
  if (!el) return;
  stickersCache = Array.isArray(stickers) ? stickers : [];
  const totalPages = Math.max(1, Math.ceil(stickersCache.length / STICKERS_PAGE_SIZE) || 1);
  if (stickersPage > totalPages) stickersPage = totalPages;
  if (stickersPage < 1) stickersPage = 1;

  if (!stickersCache.length) {
    el.innerHTML =
      '<li class="meta">No stickers yet. Upload .webp files with clear names (thanks, bestie, haha).</li>';
    renderStickersPager();
    return;
  }

  const start = (stickersPage - 1) * STICKERS_PAGE_SIZE;
  const pageRows = stickersCache.slice(start, start + STICKERS_PAGE_SIZE);
  const base = window.ASKBACK_BASE || '';
  el.innerHTML = pageRows
    .map((d) => {
      const src = `${base}/api/documents/${d.id}/file`;
      return `
      <li class="file-item" data-id="${d.id}" data-title="${escapeHtml(d.title || d.filename)}" data-filename="${escapeHtml(d.filename)}">
        <div class="sticker-row">
          <img
            class="sticker-thumb"
            src="${src}"
            alt="${escapeHtml(d.title || d.filename || 'sticker')}"
            loading="lazy"
            decoding="async"
            onerror="this.classList.add('sticker-thumb-missing'); this.replaceWith(Object.assign(document.createElement('div'),{className:'sticker-thumb sticker-thumb-missing',textContent:'no preview'}));"
          />
          <div>
            <h3>${escapeHtml(d.title || d.filename)}</h3>
            <p class="meta">${escapeHtml(d.filename)} · sticker · ${escapeHtml(d.created_at || '')}</p>
            <div class="file-actions">
              <button type="button" class="danger" data-action="delete">Delete</button>
            </div>
          </div>
        </div>
      </li>`;
    })
    .join('');
  renderStickersPager();
}

function renderStickersPager() {
  const pager = document.getElementById('stickers-pager');
  if (!pager) return;
  const total = stickersCache.length;
  const totalPages = Math.max(1, Math.ceil(total / STICKERS_PAGE_SIZE) || 1);
  if (total <= STICKERS_PAGE_SIZE) {
    pager.hidden = true;
    pager.innerHTML = '';
    return;
  }
  const start = (stickersPage - 1) * STICKERS_PAGE_SIZE + 1;
  const end = Math.min(stickersPage * STICKERS_PAGE_SIZE, total);
  pager.hidden = false;
  pager.innerHTML = `
    <p class="pager-meta">${start}–${end} of ${total}</p>
    <div class="pager-actions">
      <button type="button" class="ghost" data-stickers-page="prev" ${stickersPage <= 1 ? 'disabled' : ''}>Prev</button>
      <span class="pager-meta">Page ${stickersPage} / ${totalPages}</span>
      <button type="button" class="ghost" data-stickers-page="next" ${stickersPage >= totalPages ? 'disabled' : ''}>Next</button>
    </div>
  `;
}

function renderQa(rows) {
  const el = document.getElementById('qa');
  qaCache = Array.isArray(rows) ? rows : [];
  const totalPages = Math.max(1, Math.ceil(qaCache.length / QA_PAGE_SIZE) || 1);
  if (qaPage > totalPages) qaPage = totalPages;
  if (qaPage < 1) qaPage = 1;

  if (!qaCache.length) {
    el.innerHTML = '<li class="meta">No answered questions yet. Message the bot in WhatsApp.</li>';
    renderQaPager();
    return;
  }

  const start = (qaPage - 1) * QA_PAGE_SIZE;
  const pageRows = qaCache.slice(start, start + QA_PAGE_SIZE);
  el.innerHTML = pageRows
    .map(
      (r) => `
      <li>
        <div><strong>Q:</strong> ${escapeHtml(r.question)}</div>
        <div><strong>A:</strong> ${escapeHtml(r.answer)}</div>
        <p class="meta">${escapeHtml(r.group_name || r.group_jid || '')} · ${escapeHtml(r.created_at || '')}</p>
      </li>`
    )
    .join('');
  renderQaPager();
}

function renderQaPager() {
  const pager = document.getElementById('qa-pager');
  if (!pager) return;
  const total = qaCache.length;
  const totalPages = Math.max(1, Math.ceil(total / QA_PAGE_SIZE) || 1);
  if (total <= QA_PAGE_SIZE) {
    pager.hidden = true;
    pager.innerHTML = '';
    return;
  }
  const start = (qaPage - 1) * QA_PAGE_SIZE + 1;
  const end = Math.min(qaPage * QA_PAGE_SIZE, total);
  pager.hidden = false;
  pager.innerHTML = `
    <p class="pager-meta">${start}–${end} of ${total}</p>
    <div class="pager-actions">
      <button type="button" class="ghost" data-qa-page="prev" ${qaPage <= 1 ? 'disabled' : ''}>Prev</button>
      <span class="pager-meta">Page ${qaPage} / ${totalPages}</span>
      <button type="button" class="ghost" data-qa-page="next" ${qaPage >= totalPages ? 'disabled' : ''}>Next</button>
    </div>
  `;
}

function renderGroups(groups) {
  const el = document.getElementById('group-list');
  if (!groups.length) {
    el.innerHTML =
      '<li class="meta">No groups yet. Add askBack to a WhatsApp group, then open this tab again.</li>';
    return;
  }
  el.innerHTML = groups
    .map(
      (g) => `
      <li class="group-item">
        <div>
          <h3>${escapeHtml(g.name)}</h3>
          <p class="meta">${
            g.broadcast
              ? 'Community hub — WhatsApp would copy a reply into every linked group, so askBack stays silent here'
              : g.enabled
                ? 'Answering in this group only'
                : 'Silent in this group'
          }</p>
        </div>
        ${
          g.broadcast
            ? ''
            : `<button
          type="button"
          class="switch"
          role="switch"
          aria-checked="${g.enabled ? 'true' : 'false'}"
          aria-label="${escapeHtml(g.name)}"
          data-jid="${escapeHtml(g.jid)}"
        >
          <span class="switch-thumb" aria-hidden="true"></span>
        </button>`
        }
      </li>`
    )
    .join('');
}

async function refreshGroups() {
  const el = document.getElementById('group-list');
  try {
    renderGroups(await api('/api/groups'));
  } catch (err) {
    el.innerHTML = `<li class="meta"><span class="error">${escapeHtml(err.message)}</span></li>`;
  }
}

function fillSendGroups(groups) {
  const select = document.getElementById('send-group');
  if (!select) return;
  const current = select.value;
  const options = (groups || []).filter((g) => !g.broadcast);
  if (!options.length) {
    select.innerHTML = '<option value="">No groups yet — add the bot to a WhatsApp group</option>';
    return;
  }
  select.innerHTML = [
    '<option value="">Choose a group</option>',
    ...options.map(
      (g) =>
        `<option value="${escapeHtml(g.jid)}" ${g.jid === current ? 'selected' : ''}>${escapeHtml(g.name)}${
          g.enabled ? '' : ' (silent)'
        }</option>`
    ),
  ].join('');
}

async function refreshSendGroups() {
  try {
    fillSendGroups(await api('/api/groups'));
  } catch (err) {
    const select = document.getElementById('send-group');
    if (select) {
      select.innerHTML = `<option value="">${escapeHtml(err.message)}</option>`;
    }
  }
}

function renderAdmins(admins) {
  const el = document.getElementById('admins');
  if (!admins.length) {
    el.innerHTML = '<li class="meta">No admins yet. Add people askBack should tag when it does not know.</li>';
    return;
  }
  el.innerHTML = admins
    .map(
      (a) => `
      <li class="group-item" data-admin-id="${escapeHtml(a.id)}">
        <div>
          <h3>${escapeHtml(a.name)}</h3>
          <p class="meta">+${escapeHtml(a.phone)}</p>
        </div>
        <button type="button" class="danger" data-action="delete-admin">Remove</button>
      </li>`
    )
    .join('');
}

async function refresh() {
  const [stats, docs, stickers, qa, admins] = await Promise.all([
    api('/api/stats'),
    api('/api/documents'),
    api('/api/stickers'),
    api('/api/qa'),
    api('/api/admins'),
  ]);
  renderStats(stats);
  fillVoiceSelect(stats);
  renderDocs(docs);
  renderStickers(stickers);
  renderQa(qa);
  renderAdmins(admins);
  refreshSendGroups();
}

const fileInput = document.getElementById('file');
const fileLabel = document.getElementById('file-label');
const titleInput = document.getElementById('doc-title');

function suggestedTitle(filename) {
  return String(filename || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

fileInput.addEventListener('change', () => {
  const files = [...(fileInput.files || [])];
  if (!files.length) {
    fileLabel.textContent = 'Choose files';
    return;
  }
  fileLabel.textContent =
    files.length === 1 ? files[0].name : `${files.length} files selected`;
  if (files.length === 1 && !titleInput.value.trim()) {
    titleInput.value = suggestedTitle(files[0].name);
    titleInput.select();
  }
});

document.getElementById('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('upload-status');
  const files = [...(fileInput.files || [])];
  const title = titleInput.value.trim();
  if (!files.length || !title) return;
  status.textContent =
    files.length === 1 ? 'Uploading and processing…' : `Uploading and processing ${files.length} files…`;
  const body = new FormData();
  body.append('title', title);
  for (const file of files) body.append('file', file);
  try {
    const result = await api('/api/upload', { method: 'POST', body });
    const added = result.added || [result];
    const extras = added.reduce((n, item) => n + (item.extras?.length || 0), 0);
    if (added.length === 1) {
      status.textContent = `Added ${added[0].title || added[0].filename} (${added[0].chunkCount} chunks)`;
    } else {
      status.textContent = `Added ${added.length} files`;
    }
    if (extras) {
      status.textContent += ` + ${extras} media from zip${extras === 1 ? '' : 's'}`;
    }
    fileInput.value = '';
    titleInput.value = '';
    fileLabel.textContent = 'Choose files';
    await refresh();
  } catch (err) {
    status.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
});

const stickerFileInput = document.getElementById('sticker-file');
const stickerFileLabel = document.getElementById('sticker-file-label');
const stickerTitleInput = document.getElementById('sticker-title');

stickerFileInput?.addEventListener('change', () => {
  const files = [...(stickerFileInput.files || [])];
  if (!files.length) {
    stickerFileLabel.textContent = 'Choose stickers';
    return;
  }
  stickerFileLabel.textContent =
    files.length === 1 ? files[0].name : `${files.length} stickers selected`;
  if (!stickerTitleInput.value.trim() && files[0]) {
    stickerTitleInput.value = 'Stickers';
    stickerTitleInput.select();
  }
});

document.getElementById('sticker-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('sticker-status');
  const files = [...(stickerFileInput?.files || [])];
  const title = stickerTitleInput?.value.trim() || 'Stickers';
  if (!files.length) return;
  status.textContent =
    files.length === 1 ? 'Uploading sticker…' : `Uploading ${files.length} stickers…`;
  const body = new FormData();
  body.append('title', title);
  for (const file of files) body.append('file', file);
  try {
    const result = await api('/api/stickers', { method: 'POST', body });
    const added = result.added || [];
    status.textContent =
      added.length === 1
        ? `Added sticker ${added[0].title || added[0].filename}`
        : `Added ${added.length} stickers`;
    if (stickerFileInput) stickerFileInput.value = '';
    if (stickerTitleInput) stickerTitleInput.value = '';
    if (stickerFileLabel) stickerFileLabel.textContent = 'Choose stickers';
    stickersPage = 1;
    await refresh();
  } catch (err) {
    status.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
});

document.getElementById('tts-voice')?.addEventListener('change', async (e) => {
  const status = document.getElementById('send-status');
  const select = e.currentTarget;
  try {
    await api('/api/tts-voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: select.value }),
    });
    const label = select.selectedOptions[0]?.text || select.value;
    if (status) status.textContent = `Voice set to ${label}`;
    const stats = await api('/api/stats');
    renderStats(stats);
  } catch (err) {
    if (status) status.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
});

document.getElementById('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('send-status');
  const group = document.getElementById('send-group');
  const text = document.getElementById('send-text');
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  if (!group.value || !text.value.trim()) return;
  const asVoice = e.currentTarget.querySelector('input[name="send-as"]:checked')?.value === 'voice';
  btn.disabled = true;
  status.textContent = asVoice ? 'Sending voice note…' : 'Sending…';
  try {
    const result = await api('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: group.value, text: text.value, asVoice }),
    });
    text.value = '';
    status.textContent = asVoice
      ? `Sent voice note to ${result.name || 'the group'}`
      : `Sent to ${result.name || 'the group'}`;
  } catch (err) {
    status.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('admin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('admin-status');
  const name = document.getElementById('admin-name');
  const phone = document.getElementById('admin-phone');
  if (!name.value.trim() || !phone.value.trim()) return;
  status.textContent = 'Adding…';
  try {
    renderAdmins(
      await api('/api/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.value.trim(), phone: phone.value.trim() }),
      })
    );
    name.value = '';
    phone.value = '';
    status.textContent = '';
  } catch (err) {
    status.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
});

document.getElementById('admins').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="delete-admin"]');
  if (!btn) return;
  const item = btn.closest('[data-admin-id]');
  const id = item?.dataset.adminId;
  if (!id) return;
  if (!confirm('Remove this admin?')) return;
  btn.disabled = true;
  try {
    renderAdmins(await api(`/api/admins/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
});

document.getElementById('bot-toggle').addEventListener('click', async () => {
  const btn = document.getElementById('bot-toggle');
  const nextOn = btn.getAttribute('aria-checked') !== 'true';
  btn.disabled = true;
  try {
    await api('/api/bot-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: nextOn ? 'auto' : 'off' }),
    });
    await refresh();
  } catch (err) {
    btn.disabled = false;
    alert(err.message);
  }
});

document.getElementById('private-chats-toggle').addEventListener('click', async () => {
  const btn = document.getElementById('private-chats-toggle');
  const nextOn = btn.getAttribute('aria-checked') !== 'true';
  btn.disabled = true;
  try {
    await api('/api/private-chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nextOn }),
    });
    await refresh();
  } catch (err) {
    btn.disabled = false;
    alert(err.message);
  }
});

document.getElementById('daily-digest-toggle').addEventListener('click', async () => {
  const btn = document.getElementById('daily-digest-toggle');
  const nextOn = btn.getAttribute('aria-checked') !== 'true';
  btn.disabled = true;
  try {
    await api('/api/daily-digest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nextOn }),
    });
    await refresh();
  } catch (err) {
    btn.disabled = false;
    alert(err.message);
  }
});

document.getElementById('daily-digest-run').addEventListener('click', async () => {
  const btn = document.getElementById('daily-digest-run');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Sending…';
  try {
    const result = await api('/api/daily-digest/run', { method: 'POST' });
    const n = result.sent || 0;
    btn.textContent = n ? `Sent to ${n}` : 'Done';
    setTimeout(() => {
      btn.textContent = prev;
      btn.disabled = false;
    }, 2000);
  } catch (err) {
    btn.textContent = prev;
    btn.disabled = false;
    alert(err.message);
  }
});

document.getElementById('deadline-reminders-toggle').addEventListener('click', async () => {
  const btn = document.getElementById('deadline-reminders-toggle');
  const nextOn = btn.getAttribute('aria-checked') !== 'true';
  btn.disabled = true;
  try {
    await api('/api/deadline-reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nextOn }),
    });
    await refresh();
  } catch (err) {
    btn.disabled = false;
    alert(err.message);
  }
});

/** Simple on/off toggle wiring shared by the newer feature switches. */
function wireSettingToggle(id, endpoint) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', async () => {
    const nextOn = el.getAttribute('aria-checked') !== 'true';
    el.disabled = true;
    try {
      await api(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextOn }),
      });
      await refresh();
    } catch (err) {
      el.disabled = false;
      alert(err.message);
    }
  });
}

wireSettingToggle('meeting-summaries-toggle', '/api/meeting-summaries');
wireSettingToggle('repeat-nudge-toggle', '/api/repeat-nudge');
wireSettingToggle('show-sources-toggle', '/api/show-sources');

document.getElementById('group-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-jid]');
  if (!btn) return;
  const nextOn = btn.getAttribute('aria-checked') !== 'true';
  btn.disabled = true;
  try {
    renderGroups(
      await api('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid: btn.dataset.jid, enabled: nextOn }),
      })
    );
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
});

function senderHue(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

function formatChatTextHtml(text, attachments = {}) {
  const base = window.ASKBACK_BASE || '';
  const src = String(text || '');
  if (!src) return '';

  const re = /\[([^\]]*)\]\(attachment:\/\/([^)\s]+)\)/gi;
  let html = '';
  let last = 0;
  let match;
  while ((match = re.exec(src))) {
    html += escapeHtml(src.slice(last, match.index));
    const label = match[1] || 'attachment';
    const fileName = String(match[2] || '').trim();
    const id =
      attachments[fileName] ||
      attachments[fileName.split('/').pop()] ||
      null;
    if (id) {
      html += `<img class="chat-attach" src="${base}/api/documents/${id}/file" alt="${escapeHtml(label)}" loading="lazy" />`;
    } else {
      html += `<span class="chat-attach-missing">${escapeHtml(label)}</span>`;
    }
    last = match.index + match[0].length;
  }
  html += escapeHtml(src.slice(last));
  return html.replace(/\n/g, '<br>');
}

function renderChatMessages(messages, attachments = {}) {
  return messages
    .map((msg) => {
      if (msg.system) {
        return `<div class="chat-system">${escapeHtml(msg.text)}${
          msg.time ? `<span>${escapeHtml(msg.time)}</span>` : ''
        }</div>`;
      }
      const hue = senderHue(msg.sender);
      return `<article class="chat-bubble">
        ${msg.sender ? `<strong style="color:hsl(${hue},58%,34%)">${escapeHtml(msg.sender)}</strong>` : ''}
        <p>${formatChatTextHtml(msg.text, attachments)}</p>
        ${msg.time ? `<time>${escapeHtml(msg.time)}</time>` : ''}
      </article>`;
    })
    .join('');
}

function renderPreview(preview) {
  const title = document.getElementById('view-title');
  const meta = document.getElementById('view-meta');
  const body = document.getElementById('view-body');
  title.textContent = preview.title || preview.filename || 'File';
  const bits = [preview.filename, preview.kind === 'chat' ? 'chat' : preview.type].filter(Boolean);
  if (preview.kind === 'chat' && preview.messages?.length) {
    bits.push(`${preview.messages.length} messages`);
  }
  if (preview.truncated) bits.push('showing the start');
  meta.textContent = bits.join(' · ');

  if (preview.kind === 'sticker' || preview.kind === 'image' || preview.mediaUrl) {
    const base = window.ASKBACK_BASE || '';
    const url = preview.mediaUrl?.startsWith('http')
      ? preview.mediaUrl
      : `${base}${preview.mediaUrl || `/api/documents/${preview.id}/file`}`;
    body.className = 'doc-preview media-preview';
    body.innerHTML = `<img class="preview-media" src="${url}" alt="${escapeHtml(preview.title || 'Sticker')}" />`;
    return;
  }

  if (preview.kind === 'chat' && preview.messages?.length) {
    body.className = 'chat-thread';
    body.innerHTML = renderChatMessages(preview.messages, preview.attachments || {});
    return;
  }

  body.className = 'doc-preview';
  const text = String(preview.text || '').trim();
  // Chunk text that is only an attachment link → show image if we can resolve it
  const onlyAttach = text.match(/^\[([^\]]*)\]\(attachment:\/\/([^)\s]+)\)$/i);
  if (onlyAttach) {
    const fileName = onlyAttach[2];
    const id = preview.attachments?.[fileName];
    if (id) {
      const base = window.ASKBACK_BASE || '';
      body.className = 'doc-preview media-preview';
      body.innerHTML = `<img class="preview-media" src="${base}/api/documents/${id}/file" alt="${escapeHtml(onlyAttach[1] || 'Sticker')}" />`;
      return;
    }
  }
  body.innerHTML = text
    ? `<pre>${escapeHtml(text)}</pre>`
    : '<p class="meta">No readable text in this file yet.</p>';
}

const viewDialog = document.getElementById('view-dialog');
document.getElementById('view-close').addEventListener('click', () => viewDialog.close());

async function openPreview(id) {
  const title = document.getElementById('view-title');
  const meta = document.getElementById('view-meta');
  const body = document.getElementById('view-body');
  title.textContent = 'Opening…';
  meta.textContent = '';
  body.className = 'doc-preview';
  body.innerHTML = '<p class="meta">Loading…</p>';
  viewDialog.showModal();
  try {
    renderPreview(await api(`/api/documents/${encodeURIComponent(id)}/preview`));
    body.scrollTop = 0;
  } catch (err) {
    title.textContent = 'Could not open';
    body.innerHTML = `<p class="meta"><span class="error">${escapeHtml(err.message)}</span></p>`;
  }
}

const dialog = document.getElementById('edit-dialog');
const editForm = document.getElementById('edit-form');
const editTitle = document.getElementById('edit-title');
const editFile = document.getElementById('edit-file');
const editStatus = document.getElementById('edit-status');
let editingId = null;

function openEdit(id, title) {
  editingId = id;
  editTitle.value = title;
  editFile.value = '';
  editStatus.textContent = '';
  dialog.showModal();
}

document.getElementById('edit-cancel').addEventListener('click', () => {
  dialog.close();
});

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingId) return;
  const name = editTitle.value.trim();
  if (!name) return;

  const saveBtn = editForm.querySelector('button[type="submit"]');
  saveBtn.disabled = true;
  editStatus.textContent = 'Saving…';
  try {
    await api(`/api/documents/${editingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: name }),
    });
    if (editFile.files[0]) {
      editStatus.textContent = 'Replacing file and rebuilding knowledge…';
      const body = new FormData();
      body.append('file', editFile.files[0]);
      await api(`/api/documents/${editingId}/replace`, { method: 'POST', body });
    }
    dialog.close();
    await refresh();
  } catch (err) {
    editStatus.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById('stickers-pager')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-stickers-page]');
  if (!btn || btn.disabled) return;
  const totalPages = Math.max(1, Math.ceil(stickersCache.length / STICKERS_PAGE_SIZE) || 1);
  if (btn.dataset.stickersPage === 'prev') stickersPage = Math.max(1, stickersPage - 1);
  if (btn.dataset.stickersPage === 'next') stickersPage = Math.min(totalPages, stickersPage + 1);
  renderStickers(stickersCache);
});

document.getElementById('qa-pager')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-qa-page]');
  if (!btn || btn.disabled) return;
  const totalPages = Math.max(1, Math.ceil(qaCache.length / QA_PAGE_SIZE) || 1);
  if (btn.dataset.qaPage === 'prev') qaPage = Math.max(1, qaPage - 1);
  if (btn.dataset.qaPage === 'next') qaPage = Math.min(totalPages, qaPage + 1);
  renderQa(qaCache);
});

document.getElementById('docs-pager')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-docs-page]');
  if (!btn || btn.disabled) return;
  const totalPages = docsTotalPages(docsCache.length);
  if (btn.dataset.docsPage === 'prev') docsPage = Math.max(1, docsPage - 1);
  if (btn.dataset.docsPage === 'next') docsPage = Math.min(totalPages, docsPage + 1);
  renderDocs(docsCache);
});

document.getElementById('stickers')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="delete"]');
  if (!btn) return;
  const item = btn.closest('.file-item');
  const id = item?.dataset.id;
  if (!id) return;
  const name = item.dataset.title || item.dataset.filename || 'this sticker';
  if (!confirm(`Delete sticker ${name}?`)) return;
  btn.disabled = true;
  try {
    await api(`/api/documents/${id}`, { method: 'DELETE' });
    await refresh();
  } catch (err) {
    btn.disabled = false;
    alert(err.message || 'Could not delete');
  }
});

document.getElementById('docs').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const item = btn.closest('.file-item');
  const id = item?.dataset.id;
  if (!id) return;

  const action = btn.dataset.action;
  if (action === 'view') {
    openPreview(id);
    return;
  }
  if (action === 'edit') {
    openEdit(id, item.dataset.title || item.dataset.filename);
    return;
  }
  if (action === 'download') {
    window.location.href = `${window.ASKBACK_BASE || ''}/api/documents/${id}/file`;
    return;
  }
  if (action === 'delete') {
    const name = item.dataset.title || item.dataset.filename || 'this file';
    if (!confirm(`Delete ${name} from the knowledge base?`)) return;
    btn.disabled = true;
    try {
      await api(`/api/documents/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  }
});

refresh().catch((err) => {
  document.getElementById('stats-grid').innerHTML =
    `<span class="error">${escapeHtml(err.message)}</span>`;
});

const TAB_IDS = ['knowledge', 'groups', 'status', 'activity', 'analytics', 'control'];
const tabsNav = document.getElementById('site-nav');

const TUNING_LABELS = {
  kb_match_threshold: 'Knowledge match threshold',
  repeat_threshold: 'Reuse-answer threshold',
  top_k: 'Knowledge pieces (Top-K)',
  max_question_length: 'Max question length',
};

async function refreshControl() {
  const statusEl = document.getElementById('control-status');
  const tuningEl = document.getElementById('control-tuning');
  if (!statusEl || !tuningEl) return;
  try {
    const c = await api('/api/control');
    const mins = Math.round((c.uptimeSeconds || 0) / 60);
    statusEl.innerHTML = [
      ['Provider', c.provider],
      ['Chat model', String(c.chatModel || '').split('.').pop()],
      ['WhatsApp', c.whatsapp?.connected ? 'Connected' : 'Not connected'],
      ['Bot', c.botMode === 'off' ? 'Off' : 'On'],
      ['Documents', c.counts?.documents ?? 0],
      ['Chunks', c.counts?.chunks ?? 0],
      ['Q&A stored', c.counts?.qa ?? 0],
      ['Uptime', mins + 'm'],
    ]
      .map(
        ([label, value]) =>
          `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`
      )
      .join('');

    const tuning = c.tuning || {};
    tuningEl.innerHTML = Object.keys(tuning)
      .map((key) => {
        const t = tuning[key];
        const step = t.max <= 1 ? '0.01' : '1';
        return `
        <label class="field tuning-field">
          <span>${escapeHtml(TUNING_LABELS[key] || key)} <strong id="tune-val-${key}">${escapeHtml(t.value)}</strong></span>
          <input type="range" data-tune="${key}" min="${t.min}" max="${t.max}" step="${step}" value="${t.value}" />
        </label>`;
      })
      .join('');
  } catch (err) {
    statusEl.innerHTML = `<p class="hint"><span class="error">${escapeHtml(err.message)}</span></p>`;
    tuningEl.innerHTML = '';
  }
}

// Debounced save when a tuning slider moves.
let tuneTimer = null;
document.getElementById('control-tuning')?.addEventListener('input', (e) => {
  const input = e.target.closest('input[data-tune]');
  if (!input) return;
  const key = input.dataset.tune;
  const val = input.value;
  const label = document.getElementById(`tune-val-${key}`);
  if (label) label.textContent = val;
  clearTimeout(tuneTimer);
  tuneTimer = setTimeout(async () => {
    try {
      await api('/api/tuning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: val }),
      });
    } catch (err) {
      alert(err.message);
    }
  }, 400);
});

async function controlAction(id, endpoint, confirmMsg, doneMsg) {
  const btn = document.getElementById(id);
  const status = document.getElementById('control-action-status');
  if (!btn) return;
  if (confirmMsg && !confirm(confirmMsg)) return;
  btn.disabled = true;
  try {
    const r = await api(endpoint, { method: 'POST' });
    if (status) status.textContent = typeof doneMsg === 'function' ? doneMsg(r) : doneMsg;
    await refreshControl();
  } catch (err) {
    if (status) status.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('ctl-clear-qa')?.addEventListener('click', () =>
  controlAction(
    'ctl-clear-qa',
    '/api/maintenance/clear-qa',
    'Delete ALL stored Q&A history? Knowledge files are kept. This cannot be undone.',
    (r) => `Cleared ${r.deleted || 0} stored answers.`
  )
);

document.getElementById('ctl-rebuild')?.addEventListener('click', () =>
  controlAction(
    'ctl-rebuild',
    '/api/maintenance/rebuild-embeddings',
    'Recompute embeddings for every knowledge chunk? Runs in the background.',
    (r) => `Rebuilding embeddings for ${r.queued || 0} chunks in the background.`
  )
);

document.getElementById('ctl-repair')?.addEventListener('click', () =>
  controlAction(
    'ctl-repair',
    '/api/whatsapp/re-pair',
    'Disconnect WhatsApp and show a new QR to pair a different number?',
    'Re-pairing started. Open the Status tab to scan the new QR.'
  )
);


/** Render one labelled list block (title + rows) for the analytics tab. */
function analyticsList(title, rows, rowFn, empty) {
  const items = (rows || []).map(rowFn).join('');
  return `
    <div class="subsection">
      <h3>${escapeHtml(title)}</h3>
      ${items ? `<ul class="file-list">${items}</ul>` : `<p class="meta">${escapeHtml(empty || 'No data yet.')}</p>`}
    </div>`;
}

/** Render a compact bar chart from {label, value} pairs. */
function analyticsBars(title, pairs, empty) {
  const data = pairs || [];
  const max = data.reduce((m, d) => Math.max(m, Number(d.value) || 0), 0) || 1;
  const bars = data
    .map(
      (d) => `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(d.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.round((Number(d.value) / max) * 100)}%"></span></span>
        <span class="bar-value">${escapeHtml(d.value)}</span>
      </div>`
    )
    .join('');
  return `
    <div class="subsection">
      <h3>${escapeHtml(title)}</h3>
      ${bars ? `<div class="bar-chart">${bars}</div>` : `<p class="meta">${escapeHtml(empty || 'No data yet.')}</p>`}
    </div>`;
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

async function refreshAnalytics() {
  const summaryEl = document.getElementById('analytics-summary');
  const bodyEl = document.getElementById('analytics-body');
  if (!summaryEl || !bodyEl) return;
  try {
    const a = await api('/api/analytics');
    const t = a.totals || {};
    summaryEl.innerHTML = [
      ['Questions', t.totalQuestions ?? 0],
      ['Today', t.questionsToday ?? 0],
      ['Last 7 days', t.questions7d ?? 0],
      ['Documents', t.documents ?? 0],
      ['Active members', t.activeMembers ?? 0],
      ['Tracked messages', t.trackedMessages ?? 0],
    ]
      .map(
        ([label, value]) =>
          `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`
      )
      .join('');

    const parts = [];

    parts.push(
      analyticsBars(
        'Questions per day (14 days)',
        (a.questionsPerDay || []).map((d) => ({ label: d.day, value: d.count })),
        'No questions answered yet.'
      )
    );

    parts.push(
      analyticsBars(
        'Answer sources',
        (a.answerSources || []).map((d) => ({ label: d.source, value: d.count })),
        'No answers yet.'
      )
    );

    parts.push(
      analyticsBars(
        'Busiest hours (UTC)',
        (a.busiestHours || []).map((d) => ({ label: `${String(d.hour).padStart(2, '0')}:00`, value: d.count })),
        'No messages tracked yet.'
      )
    );

    parts.push(
      analyticsList(
        'Most active members',
        a.topMembers,
        (m) => `<li class="file-item"><h3>${escapeHtml(m.name)}</h3><p class="meta">${escapeHtml(m.messages)} messages</p></li>`,
        'No member activity seen yet.'
      )
    );

    parts.push(
      analyticsList(
        'Group activity',
        a.groupActivity,
        (g) =>
          `<li class="file-item"><h3>${escapeHtml(g.name)}</h3><p class="meta">${escapeHtml(g.messages)} messages · ${escapeHtml(g.questions)} questions${g.lastActive ? ` · last ${escapeHtml(fmtDate(g.lastActive))}` : ''}</p></li>`,
        'No group activity yet.'
      )
    );

    parts.push(
      analyticsList(
        'Most-used documents',
        a.topDocuments,
        (d) => `<li class="file-item"><h3>${escapeHtml(d.title || d.filename)}</h3><p class="meta">${escapeHtml(d.type)} · used ${escapeHtml(d.uses)} times</p></li>`,
        'No documents used yet.'
      )
    );

    parts.push(
      analyticsList(
        'Knowledge gaps (low-confidence answers)',
        a.knowledgeGaps,
        (k) =>
          `<li class="file-item"><h3>${escapeHtml(String(k.question).slice(0, 120))}</h3><p class="meta">match ${k.score != null ? Math.round(k.score * 100) + '%' : 'n/a'}${k.groupName ? ` · ${escapeHtml(k.groupName)}` : ''}</p></li>`,
        'No gaps flagged. Either coverage is good or few questions have been asked.'
      )
    );

    parts.push(
      analyticsList(
        'Frequently asked',
        a.topRepeatedQuestions,
        (q) => `<li class="file-item"><h3>${escapeHtml(String(q.question).slice(0, 120))}</h3><p class="meta">asked ${escapeHtml(q.timesAnswered)} times</p></li>`,
        'No repeated questions yet.'
      )
    );

    bodyEl.innerHTML = parts.join('');
  } catch (err) {
    summaryEl.innerHTML = `<p class="hint"><span class="error">${escapeHtml(err.message)}</span></p>`;
    bodyEl.innerHTML = '';
  }
}


function showTab(id, { updateHash = true } = {}) {
  const tabId = TAB_IDS.includes(id) ? id : 'knowledge';
  TAB_IDS.forEach((name) => {
    const selected = name === tabId;
    const panel = document.getElementById(name);
    const tab = document.getElementById(`tab-${name}`);
    panel.hidden = !selected;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  if (tabId === 'groups') refreshGroups();
  if (tabId === 'knowledge') refreshSendGroups();
  if (tabId === 'status') refreshWhatsAppPair();
  if (tabId === 'analytics') refreshAnalytics();
  if (tabId === 'control') refreshControl();
  if (updateHash && location.hash !== `#${tabId}`) {
    history.replaceState(null, '', `#${tabId}`);
  }
}

tabsNav.querySelectorAll('[role="tab"]').forEach((tab) => {
  tab.addEventListener('click', () => {
    showTab(tab.getAttribute('aria-controls'));
  });
});

tabsNav.addEventListener('keydown', (e) => {
  const buttons = [...tabsNav.querySelectorAll('[role="tab"]')];
  const index = buttons.indexOf(document.activeElement);
  if (index < 0) return;
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  e.preventDefault();
  const next =
    e.key === 'ArrowRight'
      ? (index + 1) % buttons.length
      : (index - 1 + buttons.length) % buttons.length;
  buttons[next].focus();
  showTab(buttons[next].getAttribute('aria-controls'));
});

document.querySelector('.brand')?.addEventListener('click', (e) => {
  e.preventDefault();
  showTab('knowledge');
});

window.addEventListener('hashchange', () => {
  showTab(location.hash.replace('#', ''), { updateHash: false });
});

showTab(location.hash.replace('#', '') || 'knowledge', { updateHash: false });
setInterval(refreshWhatsAppPair, 3000);
refreshWhatsAppPair();
