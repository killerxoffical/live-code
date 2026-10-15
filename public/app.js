// ============================================
// ShareDrop — Client Application (Light v2)
// Robust create / join + polished UX
// ============================================

let socket = null;
let socketConnected = false;
let currentRoom = null;
let currentUsername = '';
let chatExpanded = false;
let pendingJoinCode = null;

// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
  initSocket();
  setupDragDrop();
  setupFileInput();
  setupChatInput();
  checkURLForRoom();

  const usernameInput = document.getElementById('username-input');
  if (usernameInput) usernameInput.focus();

  const codeInput = document.getElementById('join-code-input');
  if (codeInput) {
    // Auto uppercase + strip invalid chars
    codeInput.addEventListener('input', (e) => {
      const pos = e.target.selectionStart;
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
      try { e.target.setSelectionRange(pos, pos); } catch (_) {}
    });
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinRoom();
    });
  }

  if (usernameInput) {
    usernameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // If invite code present, join directly, otherwise create
        if (pendingJoinCode) joinRoom();
        else document.getElementById('btn-create-room').focus();
      }
    });
  }
});

function initSocket() {
  try {
    socket = io({ reconnection: true, reconnectionAttempts: Infinity, timeout: 10000 });
  } catch (err) {
    setConnectionStatus(false);
    showToast('Realtime connection failed. Room actions may still work via API.', 'error');
    return;
  }
  setupSocketListeners();
}

function setConnectionStatus(online) {
  socketConnected = online;
  const el = document.getElementById('connection-status');
  if (!el) return;
  if (online) {
    el.innerHTML = '<span class="dot dot-online"></span> Connected — ready to create or join';
    el.classList.add('online');
  } else {
    el.innerHTML = '<span class="dot dot-offline"></span> Connecting… (check that server is running)';
    el.classList.remove('online');
  }
}

// Check URL for room parameter (?room=XXXXX from QR / shared link)
function checkURLForRoom() {
  const params = new URLSearchParams(window.location.search);
  const room = (params.get('room') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (room) {
    const input = document.getElementById('join-code-input');
    if (input) input.value = room;
    pendingJoinCode = room;
    const banner = document.getElementById('invite-banner');
    const codeText = document.getElementById('invite-code-text');
    if (banner) banner.style.display = 'flex';
    if (codeText) codeText.textContent = room;
    // Guide user to username field so Join works in 1 tap
    setTimeout(() => {
      const u = document.getElementById('username-input');
      if (u) u.focus();
    }, 300);
  }
}

// --- Socket Listeners ---
function setupSocketListeners() {
  setConnectionStatus(false);

  socket.on('connect', () => {
    setConnectionStatus(true);
    // Auto re-join after reconnect (e.g. wifi drop)
    if (currentRoom && currentUsername) {
      socket.emit('join-room', { roomCode: currentRoom.code, username: currentUsername });
    }
  });

  socket.on('disconnect', () => {
    setConnectionStatus(false);
  });

  socket.on('connect_error', () => {
    setConnectionStatus(false);
  });

  socket.on('room-joined', (data) => {
    currentRoom = data.room;
    showScreen('room-screen');
    document.getElementById('room-code-text').textContent = currentRoom.code;
    updateFilesList(currentRoom.files || []);
    updateMembersList(data.members || []);
    loadQRCode();
    setButtonLoading('btn-create-room', false);
    setButtonLoading('btn-join-room', false);
    showToast('Joined room successfully!', 'success');
  });

  socket.on('file-uploaded', (file) => {
    if (currentRoom) {
      currentRoom.files.push(file);
      updateFilesList(currentRoom.files);
      showToast(`${file.uploadedBy} shared "${file.originalName}"`, 'info');
    }
  });

  socket.on('file-deleted', ({ fileId }) => {
    if (currentRoom) {
      currentRoom.files = currentRoom.files.filter(f => f.id !== fileId);
      updateFilesList(currentRoom.files);
    }
  });

  socket.on('user-joined', ({ username, members }) => {
    updateMembersList(members);
    addSystemMessage(`${username} joined the room`);
    showToast(`${username} joined the room`, 'info');
  });

  socket.on('user-left', ({ username, members }) => {
    updateMembersList(members);
    addSystemMessage(`${username} left the room`);
  });

  socket.on('chat-message', (data) => {
    addChatMessage(data);
  });

  // NOTE: server emits 'room-error' (primary). 'error' kept for backwards compat.
  // 'error' is reserved in socket.io so we listen to both.
  const onRoomError = (data) => {
    setButtonLoading('btn-create-room', false);
    setButtonLoading('btn-join-room', false);
    showToast((data && data.message) || 'Something went wrong', 'error');
  };
  socket.on('room-error', onRoomError);
  socket.on('error', onRoomError);
}

// --- Button loading helper ---
function setButtonLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.original) btn.dataset.original = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('btn-loading');
    btn.innerHTML = '<span class="spinner"></span><span>Please wait…</span>';
  } else {
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    if (btn.dataset.original) {
      btn.innerHTML = btn.dataset.original;
      delete btn.dataset.original;
    }
  }
}

function ensureSocket() {
  if (!socket || !socketConnected) {
    showToast('Not connected to server yet. Wait a moment and try again.', 'error');
    return false;
  }
  return true;
}

// --- Room Actions ---
async function createRoom() {
  currentUsername = document.getElementById('username-input').value.trim().slice(0, 20) || 'Anonymous';
  if (!ensureSocket()) return;

  setButtonLoading('btn-create-room', true);
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUsername })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error((data && data.message) || `Server responded ${res.status}`);
    }
    socket.emit('join-room', { roomCode: data.room.code, username: currentUsername });
    window.history.pushState({}, '', `?room=${data.room.code}`);
    pendingJoinCode = null;
    const banner = document.getElementById('invite-banner');
    if (banner) banner.style.display = 'none';
    // Fallback: if socket event is lost, still enter room from API response
    setTimeout(() => {
      if (!currentRoom || currentRoom.code !== data.room.code) {
        currentRoom = data.room;
        showScreen('room-screen');
        document.getElementById('room-code-text').textContent = currentRoom.code;
        updateFilesList(currentRoom.files || []);
        updateMembersList([currentUsername]);
        loadQRCode();
        setButtonLoading('btn-create-room', false);
      }
    }, 2500);
  } catch (err) {
    setButtonLoading('btn-create-room', false);
    console.error(err);
    showToast('Failed to create room. Is the server running? (npm start)', 'error');
  }
}

async function joinRoom() {
  const codeInput = document.getElementById('join-code-input');
  const code = (codeInput.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  currentUsername = document.getElementById('username-input').value.trim().slice(0, 20) || 'Anonymous';

  if (!code || code.length !== 5) {
    showToast('Please enter a valid 5-character room code', 'error');
    codeInput.focus();
    return;
  }
  if (!ensureSocket()) return;

  setButtonLoading('btn-join-room', true);
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      setButtonLoading('btn-join-room', false);
      showToast((data && data.message) || 'Room not found. Check the code and try again.', 'error');
      codeInput.focus();
      codeInput.select();
      return;
    }
    socket.emit('join-room', { roomCode: code, username: currentUsername });
    window.history.pushState({}, '', `?room=${code}`);
    pendingJoinCode = null;
    const banner = document.getElementById('invite-banner');
    if (banner) banner.style.display = 'none';
    // Fallback if socket is slow
    setTimeout(() => {
      if (!currentRoom || currentRoom.code !== code) {
        setButtonLoading('btn-join-room', false);
      }
    }, 2500);
  } catch (err) {
    setButtonLoading('btn-join-room', false);
    console.error(err);
    showToast('Failed to join room. Check your connection and try again.', 'error');
  }
}

function leaveRoom() {
  try { socket.emit('leave-room'); } catch (_) {}
  currentRoom = null;
  showScreen('landing-screen');
  window.history.pushState({}, '', '/');
  // Reset invite state
  pendingJoinCode = null;
  const banner = document.getElementById('invite-banner');
  if (banner) banner.style.display = 'none';
  const codeInput = document.getElementById('join-code-input');
  if (codeInput) codeInput.value = '';
}

// --- File Upload ---
function setupDragDrop() {
  const zone = document.getElementById('upload-zone-inner');
  if (!zone) return;

  zone.addEventListener('click', () => {
    document.getElementById('file-input').click();
  });

  ;['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  }));
  ;['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
  }));

  zone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files);
    }
  });
}

function setupFileInput() {
  const input = document.getElementById('file-input');
  if (!input) return;
  input.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      uploadFiles(e.target.files);
    }
  });
}

async function uploadFiles(files) {
  if (!currentRoom) return;
  for (const file of files) {
    await uploadSingleFile(file);
  }
}

async function uploadSingleFile(file) {
  const progressEl = document.getElementById('upload-progress');
  const filenameEl = document.getElementById('upload-filename');
  const percentEl = document.getElementById('upload-percent');
  const fillEl = document.getElementById('progress-fill');

  progressEl.style.display = 'block';
  filenameEl.textContent = file.name;
  percentEl.textContent = '0%';
  fillEl.style.width = '0%';

  const formData = new FormData();
  formData.append('file', file);
  formData.append('username', currentUsername);

  try {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        percentEl.textContent = `${percent}%`;
        fillEl.style.width = `${percent}%`;
      }
    });

    await new Promise((resolve, reject) => {
      xhr.onload = () => {
        if (xhr.status === 200) {
          try {
            const response = JSON.parse(xhr.responseText);
            if (response.success) showToast(`"${file.name}" uploaded successfully!`, 'success');
          } catch (_) {}
          resolve();
        } else {
          reject(new Error('Upload failed: ' + xhr.status));
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed'));

      xhr.open('POST', `/api/rooms/${encodeURIComponent(currentRoom.code)}/upload`);
      xhr.send(formData);
    });
  } catch (err) {
    showToast(`Failed to upload "${file.name}"`, 'error');
  }

  setTimeout(() => {
    progressEl.style.display = 'none';
    fillEl.style.width = '0%';
  }, 1500);

  document.getElementById('file-input').value = '';
}

// --- Files List (XSS-safe, quote-safe via data-attributes + delegation) ---
function updateFilesList(files) {
  const listEl = document.getElementById('files-list');
  const countEl = document.getElementById('file-count');

  files = Array.isArray(files) ? files : [];
  countEl.textContent = `${files.length} file${files.length !== 1 ? 's' : ''}`;

  if (files.length === 0) {
    listEl.innerHTML = '';
    listEl.appendChild(createEmptyState());
    return;
  }

  listEl.innerHTML = files.map(file => createFileItem(file)).join('');
}

function createEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `
    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.3">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
      <polyline points="13 2 13 9 20 9"/>
    </svg>
    <p>No files shared yet</p>
    <span>Upload files to share with room members</span>
  `;
  return div;
}

function createFileItem(file) {
  const ext = getFileExtension(file.originalName);
  const typeClass = getFileTypeClass(file.mimetype, ext);
  const size = formatFileSize(file.size);
  const time = formatTime(file.uploadedAt);
  const safeName = escapeHtml(file.originalName);
  const safeBy = escapeHtml(file.uploadedBy || 'Anonymous');
  const safeFilename = escapeAttr(file.filename);
  const safeId = escapeAttr(file.id);

  return `
    <div class="file-item" data-file-id="${safeId}">
      <div class="file-icon ${typeClass}">${escapeHtml(ext.toUpperCase().substring(0, 4))}</div>
      <div class="file-details">
        <div class="file-name" title="${safeName}">${safeName}</div>
        <div class="file-meta"><span>${size}</span><span>•</span><span>${safeBy}</span><span>•</span><span>${time}</span></div>
      </div>
      <div class="file-actions">
        <button class="btn btn-icon btn-ghost btn-download" data-action="download" data-filename="${safeFilename}" data-original="${safeName}" aria-label="Download">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="btn btn-icon btn-ghost btn-delete" data-action="delete" data-file-id="${safeId}" aria-label="Delete">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
  `;
}

// Event delegation for download / delete (avoids broken inline onclick with quotes)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-action');
  if (action === 'download') {
    downloadFile(btn.getAttribute('data-filename'), btn.getAttribute('data-original') || 'file');
  } else if (action === 'delete') {
    deleteFile(btn.getAttribute('data-file-id'));
  }
});

function downloadFile(filename, originalName) {
  if (!currentRoom || !filename) return;
  const link = document.createElement('a');
  link.href = `/api/rooms/${encodeURIComponent(currentRoom.code)}/files/${encodeURIComponent(filename)}`;
  link.download = originalName || filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function deleteFile(fileId) {
  if (!currentRoom || !fileId) return;
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoom.code)}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (data.success) showToast('File deleted', 'success');
    else showToast('Failed to delete file', 'error');
  } catch (err) {
    showToast('Failed to delete file', 'error');
  }
}

// --- QR Code ---
async function loadQRCode() {
  if (!currentRoom) return;
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoom.code)}/qr`);
    const data = await res.json();
    if (data.success) {
      document.getElementById('qr-code-img').src = data.qr;
      document.getElementById('qr-room-code').textContent = currentRoom.code;
    }
  } catch (err) {
    console.error('Failed to load QR code');
  }
}

function toggleQRModal() {
  document.getElementById('qr-modal').classList.toggle('active');
}
function toggleMembersPanel() {
  document.getElementById('members-modal').classList.toggle('active');
}
function closeModalOutside(event, modalId) {
  if (event.target.id === modalId) document.getElementById(modalId).classList.remove('active');
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
  }
});

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMsg, 'success');
  } catch (_) {
    // Fallback for non-secure contexts (http on LAN)
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast(okMsg, 'success');
    } catch (_) {
      showToast('Copy failed. Long-press to copy manually.', 'error');
    }
    document.body.removeChild(ta);
  }
}

function copyRoomCode() {
  if (!currentRoom) return;
  copyText(currentRoom.code, 'Room code copied!');
}
function copyRoomLink() {
  if (!currentRoom) return;
  copyText(`${window.location.origin}/?room=${currentRoom.code}`, 'Room link copied!');
}

// --- Members ---
function updateMembersList(members) {
  members = Array.isArray(members) ? members : [];
  document.getElementById('member-count').textContent = members.length;
  const listEl = document.getElementById('members-list');
  const colors = ['#6C5CE7', '#0891B2', '#E11D48', '#D97706', '#059669', '#7C3AED', '#DB2777', '#0284C7', '#65A30D', '#0D9488'];
  if (members.length === 0) {
    listEl.innerHTML = '<div class="empty-state" style="padding:24px;"><p>No members yet</p></div>';
    return;
  }
  listEl.innerHTML = members.map((name, i) => {
    const safe = escapeHtml(name || 'Anonymous');
    const color = colors[i % colors.length];
    const initial = (name || 'A').charAt(0).toUpperCase();
    return `<div class="member-item"><div class="member-avatar" style="background:${color}">${escapeHtml(initial)}</div><span class="member-name">${safe}</span><div class="member-status"></div></div>`;
  }).join('');
}

// --- Chat ---
function setupChatInput() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}
function toggleChat() {
  const section = document.getElementById('chat-section');
  section.classList.toggle('expanded');
  chatExpanded = section.classList.contains('expanded');
  if (chatExpanded) {
    setTimeout(() => {
      const el = document.getElementById('chat-messages');
      el.scrollTop = el.scrollHeight;
    }, 100);
  }
}
function sendMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message || !currentRoom) return;
  socket.emit('chat-message', { message: message.slice(0, 1000) });
  input.value = '';
  input.focus();
}
function addChatMessage(data) {
  const messagesEl = document.getElementById('chat-messages');
  const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-msg';
  msgEl.innerHTML = `<div class="chat-msg-header"><span class="chat-msg-user">${escapeHtml(data.username)}</span><span class="chat-msg-time">${time}</span></div><div class="chat-msg-text">${escapeHtml(data.message)}</div>`;
  messagesEl.appendChild(msgEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  if (!chatExpanded) toggleChat();
}
function addSystemMessage(text) {
  const messagesEl = document.getElementById('chat-messages');
  if (!messagesEl) return;
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-msg system';
  msgEl.innerHTML = `<div class="chat-msg-text">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(msgEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// --- Screen Management ---
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  window.scrollTo(0, 0);
}

// --- Toast Notifications ---
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons = {
    success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-icon">${icons[type] || icons.info}</div><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  while (container.children.length > 4) container.firstChild.remove();
  setTimeout(() => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// --- Utility Functions ---
function getFileExtension(filename) {
  const s = String(filename || '');
  const parts = s.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase().slice(0, 8) : 'file';
}
function getFileTypeClass(mimetype, ext) {
  if (mimetype && mimetype.startsWith('image/')) return 'type-image';
  if (mimetype && mimetype.startsWith('video/')) return 'type-video';
  if (mimetype && mimetype.startsWith('audio/')) return 'type-audio';
  const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv'];
  if (docExts.includes(ext)) return 'type-document';
  const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
  if (archiveExts.includes(ext)) return 'type-archive';
  const codeExts = ['js', 'ts', 'py', 'html', 'css', 'json', 'xml', 'java', 'cpp', 'c', 'rb', 'php', 'go', 'rs'];
  if (codeExts.includes(ext)) return 'type-code';
  return 'type-other';
}
function formatFileSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
function formatTime(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date)) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(text) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(text ?? '')));
  return div.innerHTML;
}
function escapeAttr(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Service Worker (offline support) ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
