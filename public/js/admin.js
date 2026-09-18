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
  el.innerHTML = [
    ['QA answers', s.totalQA],
    ['Today', s.todayQA],
    ['Documents', s.totalDocs],
    ['Chunks', s.totalChunks],
    ['Bot', botOn ? 'On' : 'Off'],
    ['Voice', prettyVoice(s)],
  ]
    .map(
      ([label, value]) =>
        `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${label}</span></div>`
    )
    .join('');

  setBotToggle(botOn);
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

function setBotToggle(on) {
  const btn = document.getElementById('bot-toggle');
  btn.setAttribute('aria-checked', String(on));
  btn.disabled = false;
}

function renderDocs(docs) {
  const el = document.getElementById('docs');
  if (!docs.length) {
    el.innerHTML = '<li class="meta">No files yet. Add a WhatsApp .txt export, PDF, or audio recording above.</li>';
    return;
  }
  el.innerHTML = docs
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
          <button type="button" class="ghost" data-action="edit">Edit</button>
          ${d.downloadable ? '<button type="button" class="ghost" data-action="download">Download</button>' : ''}
          <button type="button" class="danger" data-action="delete">Delete</button>
        </div>
      </li>`
    )
    .join('');
}

function renderQa(rows) {
  const el = document.getElementById('qa');
  if (!rows.length) {
    el.innerHTML = '<li class="meta">No answered questions yet. Message the bot in WhatsApp.</li>';
    return;
  }
  el.innerHTML = rows
    .map(
      (r) => `
      <li>
        <div><strong>Q:</strong> ${escapeHtml(r.question)}</div>
        <div><strong>A:</strong> ${escapeHtml(r.answer)}</div>
        <p class="meta">${escapeHtml(r.group_name || r.group_jid || '')} · ${escapeHtml(r.created_at || '')}</p>
      </li>`
    )
    .join('');
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
  const [stats, docs, qa, admins] = await Promise.all([
    api('/api/stats'),
    api('/api/documents'),
    api('/api/qa'),
    api('/api/admins'),
  ]);
  renderStats(stats);
  fillVoiceSelect(stats);
  renderDocs(docs);
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
  const name = fileInput.files[0]?.name || '';
  fileLabel.textContent = name || 'Choose a file';
  if (name && !titleInput.value.trim()) {
    titleInput.value = suggestedTitle(name);
    titleInput.select();
  }
});

document.getElementById('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('upload-status');
  const file = fileInput.files[0];
  const title = titleInput.value.trim();
  if (!file || !title) return;
  status.textContent = 'Uploading and processing…';
  const body = new FormData();
  body.append('title', title);
  body.append('file', file);
  try {
    const result = await api('/api/upload', { method: 'POST', body });
    status.textContent = `Added ${result.title || result.filename} (${result.chunkCount} chunks)`;
    fileInput.value = '';
    titleInput.value = '';
    fileLabel.textContent = 'Choose a file';
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

document.getElementById('docs').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const item = btn.closest('.file-item');
  const id = item?.dataset.id;
  if (!id) return;

  const action = btn.dataset.action;
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

const TAB_IDS = ['knowledge', 'groups', 'status', 'activity'];
const tabsNav = document.getElementById('site-nav');

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
