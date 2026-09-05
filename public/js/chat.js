const socket = io();

// AUTO LOGIN CHECK
window.addEventListener('load', () => {
  // Close all panels first
  document.querySelectorAll('#discover-panel, #search-panel, #status-panel, #privacy-panel').forEach(p => p.classList.remove('open'));
  const savedToken = localStorage.getItem('token');
  const savedUsername = localStorage.getItem('username');
  if (savedToken && savedUsername) {
    currentUser = savedUsername;
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'flex';
    document.getElementById('my-username').textContent = '🔐 ' + currentUser;
    socket.emit('set_username', currentUser);
    generateKeys().then(() => {
      loadUsers(); loadGroups(); loadMyProfilePic(); loadBlockedUsers(); initVisibility(); initPrivacy();
    });
  }
});
let currentUser = null;
let activeChat = null;
let activeChatType = null;
let activeGroupId = null;
let activeGroupName = null;
let myPrivateKey = null;
let keysReadyResolve;
const keysReady = new Promise(resolve => { 
  keysReadyResolve = resolve; 
});

const sharedKeys = {};
let deleteTarget = { msgId: null, bubble: null, fileUrl: null, fileType: null, isMine: false };
let currentFilter = 'all';
const unreadCounts = {};
let blockedUsers = [];
let viewingContactUsername = null;
let replyingTo = null;
let forwardingData = null;

const urlParams = new URLSearchParams(window.location.search);
const googleToken = urlParams.get('token');
const googleUsername = urlParams.get('username');
if (googleToken && googleUsername) {
  currentUser = googleUsername;
  localStorage.setItem('token', googleToken);
  localStorage.setItem('username', googleUsername);
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';
  document.getElementById('my-username').textContent = '🔐 ' + currentUser;
  socket.emit('set_username', currentUser);
  generateKeys().then(() => {
  loadUsers(); loadGroups(); loadMyProfilePic(); loadBlockedUsers(); initVisibility(); initPrivacy();
});
  window.history.replaceState({}, document.title, '/');
}

// ============ ENCRYPTION ============
async function generateKeys() {

  // CASE 1: Private key already exists in this browser
  const storedPrivKey = localStorage.getItem('privKey_' + currentUser);

  if (storedPrivKey) {

    const privKeyData = JSON.parse(storedPrivKey);

    myPrivateKey = await crypto.subtle.importKey(
      'jwk',
      privKeyData,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey']
    );

    // Tell the app that keys are ready
    if (keysReadyResolve) {
      keysReadyResolve();
      keysReadyResolve = null;
    }

    return;
  }


  // CASE 2: Try to get private key from server
  try {

    const serverRes = await fetch(
      `/api/users/privkey/${currentUser}`
    );

    const serverData = await serverRes.json();

    if (serverData.privKey) {

      const privKeyData = JSON.parse(serverData.privKey);

      myPrivateKey = await crypto.subtle.importKey(
        'jwk',
        privKeyData,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveKey']
      );

      localStorage.setItem(
        'privKey_' + currentUser,
        serverData.privKey
      );

      // Tell the app that keys are ready
      if (keysReadyResolve) {
        keysReadyResolve();
        keysReadyResolve = null;
      }

      return;
    }

  } catch (e) {
    console.error('Could not load private key:', e);
  }


  // CASE 3: No key exists, so create new keys
  const pair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256'
    },
    true,
    ['deriveKey']
  );

  myPrivateKey = pair.privateKey;


  // Save private key
  const privKeyExport = await crypto.subtle.exportKey(
    'jwk',
    pair.privateKey
  );

  const privKeyStr = JSON.stringify(privKeyExport);

  localStorage.setItem(
    'privKey_' + currentUser,
    privKeyStr
  );


  // Save private key on server
  await fetch(
    `/api/users/privkey/${currentUser}`,
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        privKey: privKeyStr
      })
    }
  );


  // Export public key
  const pub = await crypto.subtle.exportKey(
    'spki',
    pair.publicKey
  );

  const pubBase64 = btoa(
    String.fromCharCode(...new Uint8Array(pub))
  );


  // Save public key on server
  await fetch(
    `/api/users/key/${currentUser}`,
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        publicKey: pubBase64
      })
    }
  );


  // IMPORTANT: Tell the app that keys are ready
  if (keysReadyResolve) {
    keysReadyResolve();
    keysReadyResolve = null;
  }
}

async function getSharedKey(username) {
  if (sharedKeys[username]) return sharedKeys[username];
  const res = await fetch(`/api/users/key/${username}`);
  if (!res.ok) return null;
  const { publicKey } = await res.json();
  const keyData = Uint8Array.from(atob(publicKey), c => c.charCodeAt(0));
  const theirKey = await crypto.subtle.importKey(
    'spki', keyData, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const shared = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirKey },
    myPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
  sharedKeys[username] = shared;
  return shared;
}

async function encrypt(text, username) {
  if (!text) return '';
  const key = await getSharedKey(username);
  if (!key) return text;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)
  );
  const combined = new Uint8Array(12 + enc.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(enc), 12);
  return btoa(String.fromCharCode(...combined));
}

async function decrypt(data, username) {
  if (!data) return '';
  try {
    const key = await getSharedKey(username);
    if (!key) return data;
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const dec = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)
    );
    return new TextDecoder().decode(dec);
  } catch { return '[old message]'; }
}

// ============ AUTH ============

// ============ SOCKET EVENTS ============
socket.on('receive_private', async ({ sender, text, time, msgId, fileUrl, fileType, fileName, replyTo, disappearsAt }) => {
  await keysReady;
  if (activeChatType === 'private' && sender === activeChat) {
    const decrypted = text ? await decrypt(text, sender) : '';
    showMessage(sender, decrypted, time, msgId, false, fileUrl, fileType, fileName, replyTo, disappearsAt, 'delivered');
    socket.emit('mark_read', { chatPartner: sender });
    if (disappearsAt) {
      const msLeft = new Date(disappearsAt) - Date.now();
      if (msLeft > 0) {
        setTimeout(() => {
          const el = document.querySelector(`[data-msg-id="${msgId}"]`);
          if (el) {
            el.style.transition = 'opacity 0.5s';
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 500);
          }
        }, msLeft);
      }
    }
  } else {
    markUnread(sender);
  }
});

async function register() {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value.trim();
  if (!username || !password) return showMsg('Fill both fields');
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  showMsg(data.message);
}

async function login() {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value.trim();
  if (!username || !password) return showMsg('Fill both fields');
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (data.token) {
    currentUser = data.username;
    localStorage.setItem('token', data.token);
    localStorage.setItem('username', data.username);
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'flex';
    document.getElementById('my-username').textContent = '🔐 ' + currentUser;
    loadChatTheme(`user_${username}`);
disappearSeconds = 0;
const dBtn = document.getElementById('disappear-btn');
if (dBtn) { dBtn.style.color = '#aebac1'; dBtn.title = 'Disappearing Messages'; }
    socket.emit('set_username', currentUser);
    await generateKeys();
loadUsers(); loadGroups(); loadMyProfilePic(); loadBlockedUsers(); initVisibility(); initPrivacy();
  } else { showMsg(data.message); }
}

function showMsg(msg) {
  document.getElementById('auth-message').textContent = msg;
}

// ============ FILTER TABS ============
function showTab(tab) {
  document.getElementById('chats-tab').style.display = tab === 'chats' ? 'block' : 'none';
  document.getElementById('groups-tab').style.display = tab === 'groups' ? 'block' : 'none';
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', (tab === 'chats' && i === 0) || (tab === 'groups' && i === 1));
  });
}

function setFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  if (filter === 'groups') {
    document.getElementById('chats-tab').style.display = 'none';
    document.getElementById('groups-tab').style.display = 'block';
    document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === 1));
  } else {
    document.getElementById('chats-tab').style.display = 'block';
    document.getElementById('groups-tab').style.display = 'none';
    document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    applyUserFilter(filter);
  }
}

function applyUserFilter(filter) {
  document.querySelectorAll('#user-list .user-item').forEach(item => {
    const username = item.dataset.username;
    item.style.display = (filter === 'unread' && !unreadCounts[username]) ? 'none' : 'flex';
  });
}

function markUnread(username) {
  if (username === activeChat) return;
  unreadCounts[username] = (unreadCounts[username] || 0) + 1;
  const badge = document.querySelector(`[data-username="${username}"] .unread-badge`);
  if (badge) { badge.textContent = unreadCounts[username]; badge.style.display = 'flex'; }
}

function clearUnread(username) {
  unreadCounts[username] = 0;
  const badge = document.querySelector(`[data-username="${username}"] .unread-badge`);
  if (badge) badge.style.display = 'none';
}

// ============ GROUPS ============
function showCreateGroup() {
  const box = document.getElementById('create-group-box');
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

async function createGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) return;
  const allUsers = await fetch('/api/users').then(r => r.json());
  const members = allUsers.map(u => u.username);
  if (!members.includes(currentUser)) members.push(currentUser);
  await fetch('/api/groups/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, members, createdBy: currentUser })
  });
  document.getElementById('group-name-input').value = '';
  document.getElementById('create-group-box').style.display = 'none';
  loadGroups();
  showTab('groups');
}

// ============ LOAD USERS / GROUPS ============
async function loadUsers() {
  const [lastMsgs, allUsers] = await Promise.all([
    fetch(`/api/lastmessages/${currentUser}`).then(r => r.json()).catch(() => []),
    fetch('/api/users').then(r => r.json()).catch(() => [])
  ]);
  const userMap = {};
  allUsers.forEach(u => { userMap[u.username] = u; });
  const list = document.getElementById('user-list');
  list.innerHTML = '';
  if (lastMsgs.length === 0) {
    list.innerHTML = '<p style="color:#8696a0;text-align:center;padding:20px;font-size:13px;">No chats yet.<br>Tap 🔍 to search for friends.</p>';
    return;
  }
  lastMsgs.sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
  for (const last of lastMsgs) {
    const username = last._id;
    if (!userMap[username] || username === currentUser) continue;
    const div = document.createElement('div');
    div.className = 'user-item chat-list-item';
    div.dataset.username = username;
    const pic = await getUserAvatar(username);
    const isBlocked = blockedUsers.includes(username);
    let lastText = '';
    let lastTime = '';
    if (last.fileType === 'image') lastText = '📷 Photo';
    else if (last.fileType === 'video') lastText = '🎥 Video';
    else if (last.fileType === 'document') lastText = '📄 Document';
    else if (last.fileType === 'contact') lastText = '👤 Contact';
    else {
      const raw = last.lastText || '';
      const isEncrypted = raw.length > 30 && !raw.includes(' ') && /^[A-Za-z0-9+/=]+$/.test(raw);
      lastText = isEncrypted ? '🔐 Encrypted message' : raw;
    }
    if (lastText.length > 35) lastText = lastText.substring(0, 35) + '...';
    const d = new Date(last.lastTime);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      lastTime = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      lastTime = d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
    }
    const avatarHtml = pic
      ? `<img src="${pic}" class="chat-list-avatar" onclick="event.stopPropagation();openContactInfo('${username}')">`
      : `<span class="chat-list-initial" onclick="event.stopPropagation();openContactInfo('${username}')">${username[0].toUpperCase()}</span>`;
    div.innerHTML = `
      ${avatarHtml}
      <div class="chat-list-info">
        <div class="chat-list-row1">
          <span class="chat-list-name">${isBlocked ? '🚫 ' : ''}${username}</span>
          <span class="chat-list-time">${lastTime}</span>
        </div>
        <div class="chat-list-row2">
          <span class="chat-list-last">${last.lastSender === currentUser ? '✓ ' : ''}${lastText}</span>
          <span class="unread-badge" style="display:none;"></span>
        </div>
      </div>
    `;
    div.onclick = () => openPrivateChat(username);
    list.appendChild(div);
  }
}

async function loadGroups() {
  const groups = await fetch(`/api/groups/my/${currentUser}`).then(r => r.json());
  const list = document.getElementById('group-list');
  list.innerHTML = '';
  groups.forEach(g => {
    const div = document.createElement('div');
    div.className = 'user-item chat-list-item';
    div.dataset.groupId = g._id;
    const avatarHtml = g.groupPic
      ? `<img src="${g.groupPic}" class="chat-list-avatar">`
      : `<span class="chat-list-initial">👥</span>`;
    div.innerHTML = `
      ${avatarHtml}
      <div class="chat-list-info">
        <div class="chat-list-row1">
          <span class="chat-list-name">${g.name}</span>
        </div>
        <div class="chat-list-row2">
          <span class="chat-list-last">${g.members.length} members</span>
        </div>
      </div>
    `;
    div.onclick = () => openGroupChat(g._id, g.name, g.members, g.groupPic);
    list.appendChild(div);
  });
}

// ============ OPEN CHATS ============
async function openPrivateChat(username) {
  document.getElementById('welcome-screen').style.display = 'none';
  document.getElementById('chat-main').style.display = 'flex';
  clearUnread(username);
  activeChat = username;
  activeChatType = 'private';
  activeGroupId = null;
  activeGroupName = null;
  cancelReply();
  document.getElementById('chat-with').textContent = '🔐 ' + username + ' — E2E Encrypted';
  document.getElementById('chat-sub').textContent = '';
  document.getElementById('group-info-btn').style.display = 'none';
  document.getElementById('call-buttons').style.display = 'flex';
  document.getElementById('call-buttons').innerHTML =
    `<button onclick="startCall('voice')" title="Voice Call">📞</button>
     <button onclick="startCall('video')" title="Video Call">📹</button>`;
  document.getElementById('messages').innerHTML = '';
  socket.emit('mark_read', { chatPartner: username });
  applyMobileOpen();
  const msgs = await fetch(`/api/messages/${currentUser}/${username}`).then(r => r.json());
  for (const m of msgs) {
    if (m.deletedForEveryone) {
      showMessage(m.sender, '🚫 This message was deleted',
        new Date(m.createdAt).toLocaleTimeString(), m._id, true,
        null, null, null, null, null, m.status);
      continue;
    }
    if (m.deletedFor && m.deletedFor.includes(currentUser)) continue;
    const other = m.sender === currentUser ? username : m.sender;
    const text = m.text ? await decrypt(m.text, other) : '';
    showMessage(m.sender, text, new Date(m.createdAt).toLocaleTimeString(),
      m._id, false, m.fileUrl, m.fileType, m.fileName, m.replyTo, null, m.status);
  }
}

async function openGroupChat(groupId, groupName, members, groupPic) {
  document.getElementById('welcome-screen').style.display = 'none';
  document.getElementById('chat-main').style.display = 'flex';
  activeGroupId = groupId;
  activeGroupName = groupName;
  activeChatType = 'group';
  activeChat = null;
  cancelReply();
  const memberList = members
    ? members.filter(m => m !== currentUser).join(', ') + ', You'
    : '';
  document.getElementById('chat-with').textContent = '👥 ' + groupName;
  document.getElementById('chat-sub').textContent = memberList;
  document.getElementById('group-info-btn').style.display = 'block';
  document.getElementById('call-buttons').style.display = 'flex';
  document.getElementById('call-buttons').innerHTML =
    `<button onclick="startGroupCall('voice')">📞</button>
     <button onclick="startGroupCall('video')">📹</button>`;
  document.getElementById('messages').innerHTML = '';
  loadChatTheme(`group_${groupId}`);
  socket.emit('join_group', groupId);
  applyMobileOpen();
  const msgs = await fetch(`/api/groups/messages/${groupId}`).then(r => r.json());
  msgs.forEach(m => showMessage(m.sender, m.text,
    new Date(m.createdAt).toLocaleTimeString(), null, false,
    m.fileUrl, m.fileType, m.fileName, m.replyTo));
}

// ============ SEND MESSAGE ============
async function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text && !replyingTo) return;
  if (!text) return;
  const replyPayload = replyingTo ? {
    text: replyingTo.text,
    sender: replyingTo.sender,
    fileType: replyingTo.fileType
  } : null;
  if (activeChatType === 'private' && activeChat) {
    const encrypted = await encrypt(text, activeChat);
    const tId = 'temp_' + Date.now();
    showMessage(currentUser, text, new Date().toLocaleTimeString(), tId, false, null, null, null, replyPayload, null, 'sent');
    if (disappearSeconds > 0) {
      setTimeout(() => {
        const el = document.querySelector(`[data-msg-id="${tId}"]`) ||
          document.querySelector(`[data-msg-id^="temp_"]:last-child`);
        if (el) {
          el.style.transition = 'opacity 0.5s';
          el.style.opacity = '0';
          setTimeout(() => el.remove(), 500);
        }
      }, disappearSeconds * 1000);
    }
    socket.emit('private_message', {
      receiver: activeChat,
      text: encrypted,
      replyTo: replyPayload,
      disappearSeconds: disappearSeconds > 0 ? disappearSeconds : null
    });
      
  } else if (activeChatType === 'group' && activeGroupId) {
    socket.emit('group_message', {
      groupId: activeGroupId, text,
      replyTo: replyPayload,
      disappearSeconds: disappearSeconds > 0 ? disappearSeconds : null
    });
  }
  input.value = '';
  cancelReply();
}

// ============ FILE / MEDIA SENDING ============
function toggleAttachPanel() {
  const panel = document.getElementById('attachment-panel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

async function sendMediaFiles(input, type) {
  const files = input.files;
  if (!files.length) return;
  document.getElementById('attachment-panel').style.display = 'none';
  for (const file of files) {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/media', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.fileUrl) {
        const tempId = 'temp_' + Date.now();
        showMessage(currentUser, '', new Date().toLocaleTimeString(),
          tempId, false, data.fileUrl, data.fileType, data.fileName,
          null, null, 'sent');
        if (activeChatType === 'private' && activeChat) {
          socket.emit('private_message', {
            receiver: activeChat, text: '',
            fileUrl: data.fileUrl, fileType: data.fileType, fileName: data.fileName
          });
        } else if (activeChatType === 'group' && activeGroupId) {
          socket.emit('group_message', {
            groupId: activeGroupId, text: '',
            fileUrl: data.fileUrl, fileType: data.fileType, fileName: data.fileName
          });
        }
      }
    } catch (err) { console.error('Upload failed:', err); }
  }
}

function showContactForm() {
  document.getElementById('attachment-panel').style.display = 'none';
  document.getElementById('contact-send-modal').style.display = 'flex';
  document.getElementById('contact-send-overlay').style.display = 'block';
}

function closeContactSend() {
  document.getElementById('contact-send-modal').style.display = 'none';
  document.getElementById('contact-send-overlay').style.display = 'none';
  document.getElementById('contact-name-input').value = '';
  document.getElementById('contact-phone-input').value = '';
}

async function sendContact() {
  const name = document.getElementById('contact-name-input').value.trim();
  const phone = document.getElementById('contact-phone-input').value.trim();
  if (!name || !phone) return alert('Enter name and phone');
  const contactJson = JSON.stringify({ name, phone });
  closeContactSend();
  const tempId = 'temp_' + Date.now();
  showMessage(currentUser, '', new Date().toLocaleTimeString(),
    tempId, false, contactJson, 'contact', name, null, null, 'sent');
  if (activeChatType === 'private' && activeChat) {
    socket.emit('private_message', {
      receiver: activeChat, text: '',
      fileUrl: contactJson, fileType: 'contact', fileName: name
    });
  } else if (activeChatType === 'group' && activeGroupId) {
    socket.emit('group_message', {
      groupId: activeGroupId, text: '',
      fileUrl: contactJson, fileType: 'contact', fileName: name
    });
  }
}

// ============ RENDER FILE ============
function renderFileContent(fileUrl, fileType, fileName) {
  if (!fileUrl) return '';
  if (fileType === 'image') {
    return `<img src="${fileUrl}" style="max-width:220px;max-height:220px;border-radius:8px;cursor:pointer;display:block;margin-top:4px;" onclick="window.open('${fileUrl}','_blank')">`;
  }
  if (fileType === 'video') {
    return `<video controls style="max-width:220px;border-radius:8px;display:block;margin-top:4px;"><source src="${fileUrl}">Video not supported.</video>`;
  }
  if (fileType === 'audio' || fileType === 'voice') {
  const transcript = fileName && fileName !== 'Voice message' ? fileName : '';
  return `<div class="voice-bubble">
    <button class="voice-play-btn" onclick="playVoice(this,'${fileUrl}')">▶</button>
    <div class="voice-wave">
      <div class="voice-bar"></div><div class="voice-bar"></div>
      <div class="voice-bar"></div><div class="voice-bar"></div>
      <div class="voice-bar"></div><div class="voice-bar"></div>
    </div>
    <span class="voice-duration">🎙️</span>
  </div>${transcript ? `<div class="voice-transcript">📝 ${transcript}</div>` : ''}`;
}
  if (fileType === 'contact') {
    try {
      const c = JSON.parse(fileUrl);
      return `<div style="background:rgba(0,168,132,0.15);padding:10px;border-radius:8px;margin-top:4px;border-left:3px solid #00a884;">
        <div style="font-weight:bold;color:#e9edef;">👤 ${c.name}</div>
        <div style="font-size:12px;color:#8696a0;">${c.phone}</div>
      </div>`;
    } catch { return ''; }
  }
  return `<a href="${fileUrl}" download="${fileName || 'file'}" target="_blank" style="color:#00a884;display:flex;align-items:center;gap:6px;margin-top:4px;text-decoration:none;">📄 <span>${fileName || 'Download'}</span></a>`;
}

function renderReplyPreview(replyTo) {
  if (!replyTo || (!replyTo.text && !replyTo.fileType)) return '';
  const preview = replyTo.fileType === 'image' ? '📷 Photo'
    : replyTo.fileType === 'video' ? '🎥 Video'
    : replyTo.fileType === 'document' ? '📄 Document'
    : replyTo.fileType === 'contact' ? '👤 Contact'
    : (replyTo.text || '').substring(0, 60);
  return `<div class="reply-in-bubble">
    <span class="reply-in-sender">${replyTo.sender || ''}</span>
    <span class="reply-in-text">${preview}</span>
  </div>`;
}

function getDotsHtml(status, isMine) {
  if (!isMine) return '';
  if (status === 'read') return '<span class="msg-dots read">●●</span>';
  if (status === 'delivered') return '<span class="msg-dots delivered">●●</span>';
  return '<span class="msg-dots sent">●</span>';
}

// ============ SHOW MESSAGE ============
function showMessage(sender, text, time, msgId = null, isDeleted = false,
  fileUrl = null, fileType = null, fileName = null,
  replyTo = null, forwardedFrom = null, status = 'sent') {
  const messages = document.getElementById('messages');
  const bubble = document.createElement('div');
  const isMine = sender === currentUser;
  bubble.className = isMine ? 'message-bubble sent' : 'message-bubble received';
  if (msgId) bubble.dataset.msgId = msgId;
  bubble.dataset.fileUrl = fileUrl || '';
  bubble.dataset.fileType = fileType || '';
  bubble.dataset.msgText = text || '';
  bubble.dataset.msgSender = sender;
  bubble.dataset.isMine = isMine ? '1' : '0';
  bubble.dataset.status = status || 'sent';
  const fileHtml = renderFileContent(fileUrl, fileType, fileName);
  const replyHtml = renderReplyPreview(replyTo);
  const dotsHtml = getDotsHtml(status, isMine);
  const fwdHtml = forwardedFrom ? `<span class="fwd-label">➡️ Forwarded</span>` : '';
  const textHtml = text
    ? `<span class="text"${isDeleted ? ' style="font-style:italic;color:#8696a0"' : ''}>${text}</span>`
    : '';
  bubble.innerHTML = `
    ${fwdHtml}
    ${replyHtml}
    <span class="sender">${sender}</span>
    ${textHtml}
    ${fileHtml}
    <span class="time">${time}${dotsHtml}</span>
  `;
  if (!isDeleted) {
    bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, bubble);
    });
    let pressTimer;
    bubble.addEventListener('touchstart', () => {
      pressTimer = setTimeout(() => {
        const rect = bubble.getBoundingClientRect();
        showContextMenu(rect.left, rect.top, bubble);
      }, 700);
    });
    bubble.addEventListener('touchend', () => clearTimeout(pressTimer));
    bubble.addEventListener('touchmove', () => clearTimeout(pressTimer));
  }
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

// ============ CONTEXT MENU ============
function showContextMenu(x, y, bubble) {
  const isMine = bubble.dataset.isMine === '1';
  const msgId = bubble.dataset.msgId;
  const fileUrl = bubble.dataset.fileUrl;
  const fileType = bubble.dataset.fileType;
  const text = bubble.dataset.msgText;
  const sender = bubble.dataset.msgSender;
  deleteTarget = { msgId, bubble, fileUrl, fileType, isMine };
  const menu = document.getElementById('msg-context-menu');
  document.getElementById('ctx-delete-everyone').style.display = isMine ? 'block' : 'none';
  document.getElementById('ctx-download').style.display =
    (fileUrl && fileType !== 'contact') ? 'block' : 'none';
  menu.style.display = 'flex';
  menu.style.left = Math.min(x, window.innerWidth - 210) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 220) + 'px';
}

function closeDeleteMenu() {
  document.getElementById('msg-context-menu').style.display = 'none';
}

// ============ REPLY ============
function replyToMessage() {
  const { bubble } = deleteTarget;
  if (!bubble) return closeDeleteMenu();
  const text = bubble.dataset.msgText;
  const sender = bubble.dataset.msgSender;
  const fileType = bubble.dataset.fileType;
  replyingTo = { text, sender, fileType };
  document.getElementById('reply-sender-name').textContent = sender;
  document.getElementById('reply-text-preview').textContent =
    fileType === 'image' ? '📷 Photo'
    : fileType === 'video' ? '🎥 Video'
    : fileType === 'document' ? '📄 Document'
    : text.substring(0, 60);
  document.getElementById('reply-bar').style.display = 'flex';
  document.getElementById('message-input').focus();
  closeDeleteMenu();
}

function cancelReply() {
  replyingTo = null;
  const bar = document.getElementById('reply-bar');
  if (bar) bar.style.display = 'none';
}

// ============ FORWARD ============
async function forwardMessage() {
  const { bubble } = deleteTarget;
  if (!bubble) return closeDeleteMenu();
  forwardingData = {
    text: bubble.dataset.msgText,
    fileUrl: bubble.dataset.fileUrl,
    fileType: bubble.dataset.fileType
  };
  closeDeleteMenu();
  const users = await fetch('/api/users').then(r => r.json());
  const groups = await fetch(`/api/groups/my/${currentUser}`).then(r => r.json());
  const fwdList = document.getElementById('forward-user-list');
  fwdList.innerHTML = '';
  users.filter(u => u.username !== currentUser).forEach(u => {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.style.cursor = 'pointer';
    div.innerHTML = `<span class="chat-list-initial">${u.username[0].toUpperCase()}</span> <span style="color:#e9edef;">${u.username}</span>`;
    div.onclick = () => confirmForward('user', u.username);
    fwdList.appendChild(div);
  });
  groups.forEach(g => {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.style.cursor = 'pointer';
    div.innerHTML = `<span class="chat-list-initial">👥</span> <span style="color:#e9edef;">${g.name}</span>`;
    div.onclick = () => confirmForward('group', g._id);
    fwdList.appendChild(div);
  });
  document.getElementById('forward-modal').style.display = 'flex';
  document.getElementById('forward-overlay').style.display = 'block';
}

async function confirmForward(type, target) {
  if (!forwardingData) return;
  closeForward();
  if (type === 'user') {
    socket.emit('private_message', {
      receiver: target,
      text: forwardingData.text || '',
      fileUrl: forwardingData.fileUrl || null,
      fileType: forwardingData.fileType || null,
      forwardedFrom: currentUser
    });
    showMessage(currentUser, forwardingData.text || '',
      new Date().toLocaleTimeString(), 'temp_fwd_' + Date.now(),
      false, forwardingData.fileUrl, forwardingData.fileType,
      null, null, currentUser, 'sent');
    if (activeChat !== target) alert('Message forwarded to ' + target);
  } else {
    socket.emit('group_message', {
      groupId: target,
      text: forwardingData.text || '',
      fileUrl: forwardingData.fileUrl || null,
      fileType: forwardingData.fileType || null
    });
  }
  forwardingData = null;
}

function closeForward() {
  document.getElementById('forward-modal').style.display = 'none';
  document.getElementById('forward-overlay').style.display = 'none';
  forwardingData = null;
}

// ============ DOWNLOAD ============
function downloadFile() {
  const { fileUrl } = deleteTarget;
  if (!fileUrl) return closeDeleteMenu();
  const a = document.createElement('a');
  a.href = fileUrl;
  a.download = fileUrl.split('/').pop();
  a.target = '_blank';
  a.click();
  closeDeleteMenu();
}

// ============ DELETE ============
async function deleteForMe() {
  if (!deleteTarget.msgId) return;
  await fetch(`/api/messages/${deleteTarget.msgId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: currentUser, deleteType: 'me' })
  });
  if (deleteTarget.bubble) deleteTarget.bubble.remove();
  closeDeleteMenu();
}

async function deleteForEveryone() {
  if (!deleteTarget.msgId) return;
  try {
    const res = await fetch(`/api/messages/${deleteTarget.msgId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser, deleteType: 'everyone' })
    });
    const data = await res.json();
    if (!res.ok || !data.success) return;
    if (deleteTarget.bubble) {
      const textSpan = deleteTarget.bubble.querySelector('.text');
      if (textSpan) {
        textSpan.textContent = '🚫 This message was deleted';
        textSpan.style.fontStyle = 'italic';
        textSpan.style.color = '#8696a0';
      }
      deleteTarget.bubble.dataset.deleted = 'true';
    }
    closeDeleteMenu();
  } catch (err) { console.error(err); }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#msg-context-menu')) closeDeleteMenu();
  if (!e.target.closest('#attachment-panel') && !e.target.closest('#attach-btn')) {
    const panel = document.getElementById('attachment-panel');
    if (panel) panel.style.display = 'none';
  }
});

// ============ SOCKET EVENTS ============
socket.on('message_saved', ({ msgId, status }) => {
  const tempBubble = document.querySelector('[data-msg-id^="temp_"]');
  if (tempBubble) {
    tempBubble.dataset.msgId = msgId;
    tempBubble.dataset.status = status || 'sent';
    const timeSpan = tempBubble.querySelector('.time');
    if (timeSpan) {
      const timeText = timeSpan.textContent.replace(/●+/g, '').trim();
      timeSpan.innerHTML = timeText + getDotsHtml(status || 'sent', true);
    }
  }
});

socket.on('message_delivered', ({ messageId }) => {
  const bubble = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!bubble || bubble.dataset.status === 'read') return;
  bubble.dataset.status = 'delivered';
  const timeSpan = bubble.querySelector('.time');
  if (timeSpan) {
    const timeText = timeSpan.textContent.replace(/●+/g, '').trim();
    timeSpan.innerHTML = timeText + '<span class="msg-dots delivered">●●</span>';
  }
});

socket.on('messages_read', ({ messageIds }) => {
  messageIds.forEach(messageId => {
    const bubble = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (!bubble) return;
    bubble.dataset.status = 'read';
    const timeSpan = bubble.querySelector('.time');
    if (timeSpan) {
      const timeText = timeSpan.textContent.replace(/●+/g, '').trim();
      timeSpan.innerHTML = timeText + '<span class="msg-dots read">●●</span>';
    }
  });
});

// ============ SOCKET EVENTS ============

// ============ SOCKET EVENTS ============

socket.on('receive_private', async ({
  sender,
  text,
  time,
  msgId,
  fileUrl,
  fileType,
  fileName,
  replyTo,
  disappearsAt
}) => {

  // Wait until encryption keys are ready
  await keysReady;


  if (activeChatType === 'private' && sender === activeChat) {

    // Decrypt message
    const decrypted = text
      ? await decrypt(text, sender)
      : '';


    // Show message
    showMessage(
      sender,
      decrypted,
      time,
      msgId,
      false,
      fileUrl,
      fileType,
      fileName,
      replyTo,
      disappearsAt,
      'delivered'
    );


    // Mark message as read
    socket.emit('mark_read', {
      chatPartner: sender
    });


    // Handle disappearing messages
    if (disappearsAt) {

      const msLeft =
        new Date(disappearsAt) - Date.now();

      if (msLeft > 0) {

        setTimeout(() => {

          const el = document.querySelector(
            `[data-msg-id="${msgId}"]`
          );

          if (el) {

            el.style.transition =
              'opacity 0.5s';

            el.style.opacity = '0';

            setTimeout(() => {
              el.remove();
            }, 500);

          }

        }, msLeft);

      }

    }


    // Auto translate
    if (
      translateTo &&
      decrypted &&
      fileType !== 'voice'
    ) {

      setTimeout(async () => {

        const translated =
          await translateText(
            decrypted,
            translateTo
          );

        if (
          translated &&
          translated !== decrypted
        ) {

          const bubble = msgId
            ? document.querySelector(
                `[data-msg-id="${msgId}"]`
              )
            : document.querySelector(
                '.message-bubble.received:last-child'
              );

          if (
            bubble &&
            !bubble.querySelector(
              '.translated-text'
            )
          ) {

            const transDiv =
              document.createElement('div');

            transDiv.className =
              'translated-text';

            transDiv.textContent =
              '🌐 ' + translated;

            const timeSpan =
              bubble.querySelector('.time');

            if (timeSpan) {

              bubble.insertBefore(
                transDiv,
                timeSpan
              );

            }

          }

        }

      }, 200);

    }

  } else {

    // Chat is not currently open
    markUnread(sender);

  }

});

socket.on('receive_group_message', ({ sender, text, time, fileUrl, fileType, fileName, replyTo }) => {
  if (activeChatType === 'group') {
    showMessage(sender, text, time, null, false, fileUrl, fileType, fileName, replyTo);
  }
});

socket.on('message_deleted_everyone', ({ messageId }) => {
  const bubble = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!bubble) return;
  const textSpan = bubble.querySelector('.text');
  if (textSpan) {
    textSpan.textContent = '🚫 This message was deleted';
    textSpan.style.fontStyle = 'italic';
    textSpan.style.color = '#8696a0';
  }
  bubble.dataset.deleted = 'true';
  bubble.oncontextmenu = null;
  bubble.querySelectorAll('img, video, audio, a').forEach(el => el.remove());
});

socket.on('message_blocked', () => {
  alert('Cannot send message — you are blocked by this user.');
});

// ============ BLOCK / UNBLOCK ============
async function loadBlockedUsers() {
  try {
    const res = await fetch(`/api/users/blocked/${currentUser}`);
    const data = await res.json();
    blockedUsers = data.blocked || [];
  } catch (e) {}
}

async function toggleBlock() {
  if (!viewingContactUsername) return;
  const isBlocked = blockedUsers.includes(viewingContactUsername);
  if (isBlocked) {
    await fetch('/api/users/block', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser, blockUsername: viewingContactUsername })
    });
    blockedUsers = blockedUsers.filter(u => u !== viewingContactUsername);
    document.getElementById('block-btn').textContent = '🚫 Block';
  } else {
    await fetch('/api/users/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser, blockUsername: viewingContactUsername })
    });
    blockedUsers.push(viewingContactUsername);
    document.getElementById('block-btn').textContent = '✅ Unblock';
  }
  alert(isBlocked ? viewingContactUsername + ' unblocked.' : viewingContactUsername + ' blocked.');
  closeContactInfo();
  loadUsers();
}

// ============ GROUP INFO ============
async function openGroupInfo() {
  if (!activeGroupId) return;
  const group = await fetch(`/api/groups/${activeGroupId}`).then(r => r.json());
  document.getElementById('group-info-name').textContent = group.name;
  document.getElementById('group-info-count').textContent = group.members.length + ' members';
  const bigImg = document.getElementById('group-big-avatar');
  const bigInitial = document.getElementById('group-big-initial');
  if (group.groupPic) {
    bigImg.src = group.groupPic; bigImg.style.display = 'block'; bigInitial.style.display = 'none';
  } else {
    bigImg.style.display = 'none'; bigInitial.style.display = 'flex';
  }
  document.getElementById('group-pic-upload').dataset.groupId = group._id;
  const membersList = document.getElementById('group-members-list');
  membersList.innerHTML = '<p style="color:#8696a0;font-size:13px;padding:8px 16px;">Members</p>';
  for (const m of group.members) {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 16px;';
    const pic = await getUserAvatar(m);
    div.innerHTML = pic
      ? `<img src="${pic}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;"> <span style="color:#e9edef;">${m}${m === currentUser ? ' (You)' : ''}</span>`
      : `<span style="width:36px;height:36px;border-radius:50%;background:#00a884;color:white;display:flex;align-items:center;justify-content:center;font-weight:bold;">${m[0].toUpperCase()}</span><span style="color:#e9edef;">${m}${m === currentUser ? ' (You)' : ''}</span>`;
    membersList.appendChild(div);
  }
  const allUsers = await fetch('/api/users').then(r => r.json());
  const nonMembers = allUsers.filter(u => !group.members.includes(u.username));
  const sel = document.getElementById('add-member-select');
  sel.innerHTML = nonMembers.length
    ? nonMembers.map(u => `<option value="${u.username}">${u.username}</option>`).join('')
    : '<option value="">No users to add</option>';
  document.getElementById('add-member-box').style.display = 'none';
  document.getElementById('group-info-panel').classList.add('open');
  document.getElementById('group-info-overlay').classList.add('open');
}

function closeGroupInfo() {
  document.getElementById('group-info-panel').classList.remove('open');
  document.getElementById('group-info-overlay').classList.remove('open');
}

function showAddMember() {
  const box = document.getElementById('add-member-box');
  box.style.display = box.style.display === 'none' ? 'flex' : 'none';
}

async function confirmAddMember() {
  const sel = document.getElementById('add-member-select');
  const username = sel.value;
  if (!username || !activeGroupId) return;
  await fetch(`/api/groups/${activeGroupId}/addmember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  });
  alert(username + ' added!');
  closeGroupInfo();
  loadGroups();
}

async function exitGroup() {
  if (!activeGroupId) return;
  if (!window.confirm('Exit this group?')) return;
  await fetch(`/api/groups/${activeGroupId}/exit`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: currentUser })
  });
  closeGroupInfo();
  activeGroupId = null; activeChatType = null;
  document.getElementById('chat-with').textContent = 'Select a chat';
  document.getElementById('chat-sub').textContent = '';
  document.getElementById('messages').innerHTML = '';
  document.getElementById('group-info-btn').style.display = 'none';
  loadGroups();
}

async function uploadGroupPic(input) {
  const file = input.files[0];
  const groupId = input.dataset.groupId || activeGroupId;
  if (!file || !groupId) return;
  const formData = new FormData();
  formData.append('groupPic', file);
  const res = await fetch(`/api/groups/${groupId}/pic`, { method: 'POST', body: formData });
  const data = await res.json();
  if (data.groupPic) {
    document.getElementById('group-big-avatar').src = data.groupPic + '?t=' + Date.now();
    document.getElementById('group-big-avatar').style.display = 'block';
    document.getElementById('group-big-initial').style.display = 'none';
    loadGroups();
  }
}

async function clearChat() {
  if (!activeChat || activeChatType !== 'private') return;
  if (!window.confirm('Clear all messages?')) return;
  await fetch(`/api/clearchat/${currentUser}/${activeChat}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: currentUser })
  });
  document.getElementById('messages').innerHTML = '';
}

// ============ CONTACT INFO ============
async function openContactInfo(username) {
  viewingContactUsername = username;
  document.getElementById('contact-info-name').textContent = username;
  const isBlocked = blockedUsers.includes(username);
  document.getElementById('block-btn').textContent = isBlocked ? '✅ Unblock' : '🚫 Block';
  const img = document.getElementById('contact-big-avatar');
  const initial = document.getElementById('contact-big-initial');
  const pic = await getUserAvatar(username);
  if (pic) { img.src = pic; img.style.display = 'block'; initial.style.display = 'none'; }
  else { img.style.display = 'none'; initial.textContent = username[0].toUpperCase(); initial.style.display = 'flex'; }
  const bioRes = await fetch(`/api/users/bio/${username}`);
  const bioData = await bioRes.json();
  document.getElementById('contact-info-about').textContent = bioData.bio || 'Using priconkt';
  document.getElementById('contact-info-panel').classList.add('open');
  document.getElementById('contact-info-overlay').classList.add('open');
}

function closeContactInfo() {
  document.getElementById('contact-info-panel').classList.remove('open');
  document.getElementById('contact-info-overlay').classList.remove('open');
  viewingContactUsername = null;
}

// ============ MY PROFILE ============
async function openMyProfile() {
  const res = await fetch(`/api/users/bio/${currentUser}`);
  const data = await res.json();
  document.getElementById('my-bio-input').value = data.bio || '';
  document.getElementById('bio-char-count').textContent = (data.bio || '').length + '/150';
  document.getElementById('my-profile-username').textContent = currentUser;
  const img = document.getElementById('my-profile-big-avatar');
  const initial = document.getElementById('my-profile-big-initial');
  const pic = await getUserAvatar(currentUser);
  if (pic) { img.src = pic; img.style.display = 'block'; initial.style.display = 'none'; }
  else { img.style.display = 'none'; initial.textContent = currentUser[0].toUpperCase(); initial.style.display = 'flex'; }
  document.getElementById('my-profile-panel').classList.add('open');
  document.getElementById('my-profile-overlay-bg').classList.add('open');
}

function closeMyProfile() {
  document.getElementById('my-profile-panel').classList.remove('open');
  document.getElementById('my-profile-overlay-bg').classList.remove('open');
}

async function saveMyProfile() {
  const bio = document.getElementById('my-bio-input').value.trim();
  await fetch(`/api/users/bio/${currentUser}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bio })
  });
  closeMyProfile();
  alert('Profile saved!');
}

document.getElementById('my-bio-input')?.addEventListener('input', function() {
  document.getElementById('bio-char-count').textContent = this.value.length + '/150';
});

// ============ PROFILE PICS ============
async function loadMyProfilePic() {
  const res = await fetch(`/api/upload/${currentUser}`);
  const data = await res.json();
  const img = document.getElementById('my-avatar');
  const initial = document.getElementById('my-avatar-initial');
  if (data.profilePic) { img.src = data.profilePic; img.style.display = 'block'; initial.style.display = 'none'; }
  else { img.style.display = 'none'; initial.textContent = currentUser[0].toUpperCase(); initial.style.display = 'flex'; }
}

async function uploadProfilePic(input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('profilePic', file);
  formData.append('username', currentUser);
  const res = await fetch('/api/upload', { method: 'POST', body: formData });
  const data = await res.json();
  if (data.profilePic) {
    const img = document.getElementById('my-avatar');
    img.src = data.profilePic + '?t=' + Date.now();
    img.style.display = 'block';
    document.getElementById('my-avatar-initial').style.display = 'none';
  }
}

async function getUserAvatar(username) {
  try {
    const res = await fetch(`/api/upload/${username}`);
    const data = await res.json();
    return data.profilePic || null;
  } catch { return null; }
}

// ============ SEARCH ============
function openSearch() {
  document.getElementById('search-panel').classList.add('open');
  document.getElementById('search-overlay').classList.add('open');
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').innerHTML =
    '<p style="color:#8696a0;text-align:center;padding:20px;font-size:13px;">Type a username to search</p>';
  setTimeout(() => document.getElementById('search-input').focus(), 300);
}

function closeSearch() {
  document.getElementById('search-panel').classList.remove('open');
  document.getElementById('search-overlay').classList.remove('open');
}

async function searchUsers(query) {
  const results = document.getElementById('search-results');
  if (query.length < 1) {
    results.innerHTML = '<p style="color:#8696a0;text-align:center;padding:20px;font-size:13px;">Type a username to search</p>';
    return;
  }
  const users = await fetch('/api/users').then(r => r.json());
  const filtered = users.filter(u =>
    u.username !== currentUser &&
    u.username.toLowerCase().includes(query.toLowerCase())
  );
  results.innerHTML = '';
  if (filtered.length === 0) {
    results.innerHTML = '<p style="color:#8696a0;text-align:center;padding:20px;font-size:13px;">No user found</p>';
    return;
  }
  for (const u of filtered) {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    const pic = await getUserAvatar(u.username);
    const bioRes = await fetch(`/api/users/bio/${u.username}`);
    const bioData = await bioRes.json();
    div.innerHTML = pic
      ? `<img src="${pic}" class="chat-list-avatar"> <div><div style="color:#e9edef;">${u.username}</div><div style="color:#8696a0;font-size:12px;">${bioData.bio || 'Using priconkt'}</div></div>`
      : `<span class="chat-list-initial">${u.username[0].toUpperCase()}</span> <div><div style="color:#e9edef;">${u.username}</div><div style="color:#8696a0;font-size:12px;">${bioData.bio || 'Using priconkt'}</div></div>`;
    div.onclick = () => { closeSearch(); openPrivateChat(u.username); };
    results.appendChild(div);
  }
}

document.addEventListener('keypress', e => {
  if (e.key === 'Enter') sendMessage();
});

// ============ STATUS ============
let statusBgColor = '#111b21';
let statusFileUrl = null;
let statusFileType = null;
let currentStatusList = [];
let statusTimer = null;
let currentStatusIdx = 0;

function openStatusTab() {
  document.getElementById('status-panel').classList.add('open');
  document.getElementById('status-overlay').classList.add('open');
  loadStatuses();
}

function closeStatusTab() {
  document.getElementById('status-panel').classList.remove('open');
  document.getElementById('status-overlay').classList.remove('open');
}

async function loadStatuses() {
  const [mine, others] = await Promise.all([
    fetch(`/api/status/mine/${currentUser}`).then(r => r.json()),
    fetch(`/api/status/all/${currentUser}`).then(r => r.json())
  ]);

  const myList = document.getElementById('my-status-list');
  myList.innerHTML = '';
  if (mine.length === 0) {
    myList.innerHTML = '<p style="color:#8696a0;padding:12px 16px;font-size:13px;">No active status. Tap + Add to post.</p>';
  } else {
    mine.forEach((s, i) => {
      const div = document.createElement('div');
      div.className = 'status-item';
      const timeLeft = Math.floor((new Date(s.expiresAt) - Date.now()) / 3600000);
      div.innerHTML = `
        <div class="status-ring my-status-ring"></div>
        <div class="status-item-info">
          <span>My Status</span>
          <span class="status-time">${timeLeft}h left · ${s.viewedBy.length} views</span>
        </div>
        <button onclick="deleteMyStatus('${s._id}')" style="background:none;border:none;color:#e53935;cursor:pointer;width:auto;height:auto;font-size:16px;">🗑️</button>
      `;
      div.onclick = (e) => { if (!e.target.closest('button')) viewStatus(mine, i, 'My Status'); };
      myList.appendChild(div);
    });
  }

  const othersList = document.getElementById('others-status-list');
  othersList.innerHTML = '';
  const usernames = Object.keys(others);
  if (usernames.length === 0) {
    othersList.innerHTML = '<p style="color:#8696a0;padding:12px 16px;font-size:13px;">No recent updates from your contacts.</p>';
    return;
  }
  for (const username of usernames) {
    const statuses = others[username];
    const latest = statuses[0];
    const hasUnviewed = statuses.some(s => !s.viewedBy.includes(currentUser));
    const pic = await getUserAvatar(username);
    const div = document.createElement('div');
    div.className = 'status-item';
    const d = new Date(latest.createdAt);
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
      ${pic
        ? `<img src="${pic}" class="status-avatar-thumb" style="border: 2px solid ${hasUnviewed ? '#00a884' : '#555'};">`
        : `<span class="status-avatar-initial" style="border: 2px solid ${hasUnviewed ? '#00a884' : '#555'};">${username[0].toUpperCase()}</span>`}
      <div class="status-item-info">
        <span style="color:#e9edef;">${username}</span>
        <span class="status-time">${timeStr}</span>
      </div>
    `;
    div.onclick = () => viewStatus(statuses, 0, username);
    othersList.appendChild(div);
  }
}

function viewStatus(statuses, startIdx, username) {
  currentStatusList = statuses;
  currentStatusIdx = startIdx;
  document.getElementById('status-view-screen').style.display = 'flex';
  showStatusAt(currentStatusIdx, username);
  fetch(`/api/status/view/${statuses[startIdx]._id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: currentUser })
  });
}

function showStatusAt(idx, username) {
  const s = currentStatusList[idx];
  document.getElementById('status-view-username').textContent = username || s.username;
  const d = new Date(s.createdAt);
  document.getElementById('status-view-time').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const content = document.getElementById('status-view-content');
  content.style.background = s.backgroundColor || '#111b21';
  document.getElementById('status-view-text').textContent = s.text || '';
  const img = document.getElementById('status-view-img');
  const vid = document.getElementById('status-view-vid');
  img.style.display = 'none';
  vid.style.display = 'none';
  if (s.fileType === 'image' && s.fileUrl) {
    img.src = s.fileUrl; img.style.display = 'block';
  } else if (s.fileType === 'video' && s.fileUrl) {
    vid.src = s.fileUrl; vid.style.display = 'block';
  }
  clearInterval(statusTimer);
  const fill = document.getElementById('status-progress-fill');
  fill.style.transition = 'none';
  fill.style.width = '0%';
  setTimeout(() => {
    fill.style.transition = 'width 5s linear';
    fill.style.width = '100%';
  }, 50);
  statusTimer = setTimeout(() => {
    if (currentStatusIdx < currentStatusList.length - 1) {
      currentStatusIdx++;
      showStatusAt(currentStatusIdx, username);
    } else {
      closeStatusView();
    }
  }, 5000);
}

function closeStatusView() {
  clearInterval(statusTimer);
  document.getElementById('status-view-screen').style.display = 'none';
  loadStatuses();
}

function openPostStatus() {
  closeStatusTab();
  document.getElementById('post-status-panel').classList.add('open');
  document.getElementById('post-status-overlay').classList.add('open');
  statusBgColor = '#111b21';
  statusFileUrl = null;
  statusFileType = null;
  document.getElementById('status-text-input').value = '';
  document.getElementById('status-preview-text-show').textContent = '';
  document.getElementById('status-preview-img').style.display = 'none';
  document.getElementById('status-preview-vid').style.display = 'none';
  document.getElementById('status-preview-bg').style.background = '#111b21';
}

function closePostStatus() {
  document.getElementById('post-status-panel').classList.remove('open');
  document.getElementById('post-status-overlay').classList.remove('open');
}

function previewStatusText(val) {
  document.getElementById('status-preview-text-show').textContent = val;
}

function setStatusBg(color) {
  statusBgColor = color;
  document.getElementById('status-preview-bg').style.background = color;
}

async function previewStatusFile(input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/api/media', { method: 'POST', body: formData });
  const data = await res.json();
  if (data.fileUrl) {
    statusFileUrl = data.fileUrl;
    statusFileType = data.fileType;
    if (data.fileType === 'image') {
      document.getElementById('status-preview-img').src = data.fileUrl;
      document.getElementById('status-preview-img').style.display = 'block';
      document.getElementById('status-preview-vid').style.display = 'none';
    } else if (data.fileType === 'video') {
      document.getElementById('status-preview-vid').src = data.fileUrl;
      document.getElementById('status-preview-vid').style.display = 'block';
      document.getElementById('status-preview-img').style.display = 'none';
    }
  }
}

async function submitStatus() {
  const text = document.getElementById('status-text-input').value.trim();
  if (!text && !statusFileUrl) return alert('Add text or a photo/video');
  const formData = new FormData();
  formData.append('username', currentUser);
  formData.append('text', text);
  formData.append('backgroundColor', statusBgColor);
  const res = await fetch('/api/status', { method: 'POST', body: formData });
  const data = await res.json();
  if (data.success) {
    closePostStatus();
    openStatusTab();
  } else {
    alert('Failed to post status');
  }
}

async function deleteMyStatus(statusId) {
  if (!window.confirm('Delete this status?')) return;
  await fetch(`/api/status/${statusId}`, { method: 'DELETE' });
  loadStatuses();
}

// ============ DISCOVER (Nearby) ============
let isVisible = false;
let myLocation = null;

async function initVisibility() {
  try {
    const res = await fetch(`/api/users/visibility/${currentUser}`);
    const data = await res.json();
    isVisible = data.isVisible || false;
    updateVisibilityUI();
  } catch (e) {}
}

function updateVisibilityUI() {
  const visBtn = document.getElementById('visibility-btn');
  const visToggleBtn = document.getElementById('vis-toggle-btn');
  const visIcon = document.getElementById('vis-icon');
  const visLabel = document.getElementById('vis-label');
  const visDesc = document.getElementById('vis-desc');
  if (visBtn) {
    visBtn.style.background = isVisible ? '#00a884' : '#2a3942';
    visBtn.style.color = isVisible ? 'white' : '#8696a0';
    visBtn.title = isVisible ? 'Visible to Nearby (ON)' : 'Hidden from Nearby (OFF)';
  }
  if (visLabel) visLabel.textContent = isVisible ? 'You are Visible' : 'You are Hidden';
  if (visIcon) visIcon.textContent = isVisible ? '👁️' : '🙈';
  if (visDesc) visDesc.textContent = isVisible
    ? 'Nearby users can discover you when they scan'
    : 'Turn on visibility so nearby users can discover you';
  if (visToggleBtn) visToggleBtn.textContent = isVisible ? 'Turn Off' : 'Turn On';
  if (visToggleBtn) visToggleBtn.style.background = isVisible ? '#e53935' : '#00a884';
}

async function toggleVisibility() {
  if (!isVisible) {
    if (!navigator.geolocation) return alert('Geolocation not supported on this device');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      isVisible = true;
      await fetch('/api/users/visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser, isVisible: true, lat: myLocation.lat, lng: myLocation.lng })
      });
      updateVisibilityUI();
    }, (err) => {
      alert('Location permission required to turn on visibility.\nPlease allow location access and try again.');
    });
  } else {
    isVisible = false;
    myLocation = null;
    await fetch('/api/users/visibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser, isVisible: false })
    });
    updateVisibilityUI();
  }
}

function openDiscover() {
  document.getElementById('discover-panel').classList.add('open');
  document.getElementById('discover-overlay').classList.add('open');
  updateVisibilityUI();
  document.getElementById('discover-results').innerHTML = '';
  document.getElementById('scan-status-msg').textContent = '';
}

function closeDiscover() {
  document.getElementById('discover-panel').classList.remove('open');
  document.getElementById('discover-overlay').classList.remove('open');
}

async function scanNearby() {
  const msg = document.getElementById('scan-status-msg');
  const results = document.getElementById('discover-results');
  msg.textContent = '📡 Scanning...';
  results.innerHTML = '';
  if (!navigator.geolocation) {
    msg.textContent = '❌ Geolocation not supported';
    return;
  }
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    try {
      const res = await fetch('/api/users/nearby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser, lat, lng, radiusKm: 1 })
      });
      const users = await res.json();
      if (users.length === 0) {
        msg.textContent = '📡 No visible users nearby';
        return;
      }
      msg.textContent = `Found ${users.length} user${users.length > 1 ? 's' : ''} nearby`;
      for (const u of users) {
        const div = document.createElement('div');
        div.className = 'search-result-item';
        div.style.cursor = 'pointer';
        div.innerHTML = `
          <span class="chat-list-initial" style="background:#00a884;">${u.username[0].toUpperCase()}</span>
          <div>
            <div style="color:#e9edef;font-size:15px;">📡 ${u.username}</div>
            <div style="color:#8696a0;font-size:12px;">${u.bio || 'Using priconkt'}</div>
          </div>
        `;
        div.onclick = () => { closeDiscover(); openPrivateChat(u.username); };
        results.appendChild(div);
      }
    } catch (err) {
      msg.textContent = '❌ Scan failed. Try again.';
    }
  }, () => {
    msg.textContent = '❌ Location permission denied. Enable location to scan.';
  });
}

// ============ PRIVACY CENTER ============
let privacySettings = {};
let ghostMode = false;

async function initPrivacy() {
  try {
    const [privRes, ghostRes] = await Promise.all([
      fetch(`/api/users/privacy/${currentUser}`),
      fetch(`/api/users/ghost/${currentUser}`)
    ]);
    privacySettings = await privRes.json();
    const ghostData = await ghostRes.json();
    ghostMode = ghostData.ghostMode || false;
    updateGhostUI();
  } catch (e) {}
}

function updateGhostUI() {
  const privBtn = document.getElementById('privacy-btn');
  if (privBtn) {
    privBtn.style.background = ghostMode ? '#8696a0' : '#2a3942';
    privBtn.title = ghostMode ? 'Ghost Mode ON (click to manage)' : 'Privacy Center';
    privBtn.textContent = ghostMode ? '👻' : '🛡️';
  }
}

async function toggleGhostMode(enabled) {
  ghostMode = enabled;
  await fetch('/api/users/ghost', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: currentUser, ghostMode: enabled })
  });
  updateGhostUI();
}

async function openPrivacyCenter() {
  await initPrivacy();
  const gt = document.getElementById('ghost-toggle');
  if (gt) gt.checked = ghostMode;
  if (privacySettings) {
    const m = document.getElementById('priv-message');
    const c = document.getElementById('priv-call');
    const g = document.getElementById('priv-groups');
    const o = document.getElementById('priv-online');
    const r = document.getElementById('priv-read');
    const n = document.getElementById('priv-nearby');
    const f = document.getElementById('priv-forward');
    if (m) m.value = privacySettings.whoCanMessage || 'everyone';
    if (c) c.value = privacySettings.whoCanCall || 'everyone';
    if (g) g.value = privacySettings.whoCanAddToGroups || 'everyone';
    if (o) o.checked = privacySettings.showOnlineStatus !== false;
    if (r) r.checked = privacySettings.showReadReceipts !== false;
    if (n) n.checked = privacySettings.allowNearbyDiscovery !== false;
    if (f) f.checked = privacySettings.allowForwarding !== false;
  }
  document.getElementById('privacy-panel').classList.add('open');
  document.getElementById('privacy-overlay').classList.add('open');
}

function closePrivacyCenter() {
  document.getElementById('privacy-panel').classList.remove('open');
  document.getElementById('privacy-overlay').classList.remove('open');
}

async function savePrivacySettings() {
  const settings = {
    whoCanMessage: document.getElementById('priv-message').value,
    whoCanCall: document.getElementById('priv-call').value,
    whoCanAddToGroups: document.getElementById('priv-groups').value,
    showOnlineStatus: document.getElementById('priv-online').checked,
    showReadReceipts: document.getElementById('priv-read').checked,
    allowNearbyDiscovery: document.getElementById('priv-nearby').checked,
    allowForwarding: document.getElementById('priv-forward').checked
  };
  await fetch(`/api/users/privacy/${currentUser}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });
  privacySettings = settings;
  closePrivacyCenter();
  alert('Privacy settings saved ✅');
}

// ============ DISAPPEARING MESSAGES ============
let disappearSeconds = 0;

function openDisappearPicker() {
  document.getElementById('disappear-picker').style.display = 'flex';
  document.getElementById('disappear-overlay').style.display = 'block';
}

function closeDisappearPicker() {
  document.getElementById('disappear-picker').style.display = 'none';
  document.getElementById('disappear-overlay').style.display = 'none';
}

function setDisappearTimer(seconds) {
  disappearSeconds = seconds;
  const btn = document.getElementById('disappear-btn');
  if (btn) {
    btn.style.color = seconds > 0 ? '#00a884' : '#aebac1';
    btn.title = seconds > 0
      ? `Disappearing: ${seconds >= 86400 ? '1 day' : seconds >= 3600 ? '1 hour' : seconds >= 60 ? '1 min' : '10 sec'}`
      : 'Disappearing Messages';
  }
  closeDisappearPicker();
}

// ============ CHAT THEMES ============
const chatThemes = {
  default: { bg: '#0b141a', msgBg: '#202c33', sentBg: '#005c4b' },
  ocean:   { bg: '#0a1628', msgBg: '#0d3166', sentBg: '#005c8a' },
  galaxy:  { bg: '#08001a', msgBg: '#1a0533', sentBg: '#2d0066' },
  cricket: { bg: '#0a1f0a', msgBg: '#1b5e20', sentBg: '#2e7d32' },
  gaming:  { bg: '#050010', msgBg: '#0a0020', sentBg: '#1a003a' },
  couple:  { bg: '#1a0010', msgBg: '#4a0030', sentBg: '#880e4f' },
  study:   { bg: '#001020', msgBg: '#0d2040', sentBg: '#0277bd' },
  work:    { bg: '#121212', msgBg: '#212121', sentBg: '#37474f' },
  sunset:  { bg: '#1a0800', msgBg: '#3e1000', sentBg: '#bf360c' }
};

let currentChatTheme = 'default';

function openThemePicker() {
  document.getElementById('theme-picker').style.display = 'flex';
  document.getElementById('theme-overlay').style.display = 'block';
  document.querySelectorAll('.theme-opt').forEach(el => {
    el.style.border = el.dataset.theme === currentChatTheme
      ? '2px solid #00a884' : '2px solid transparent';
  });
}

function closeThemePicker() {
  document.getElementById('theme-picker').style.display = 'none';
  document.getElementById('theme-overlay').style.display = 'none';
}

async function applyChatTheme(themeName) {
  currentChatTheme = themeName;
  const t = chatThemes[themeName] || chatThemes.default;
  const msgs = document.getElementById('messages');
  if (msgs) msgs.style.background = t.bg;
  document.querySelectorAll('.message-bubble.received').forEach(b => {
    b.style.background = t.msgBg;
  });
  document.querySelectorAll('.message-bubble.sent').forEach(b => {
    b.style.background = t.sentBg;
  });
  document.querySelectorAll('.theme-opt').forEach(el => {
    el.style.border = el.dataset.theme === themeName
      ? '2px solid #00a884' : '2px solid transparent';
  });
  const chatKey = activeChatType === 'group' ? `group_${activeGroupId}` : `user_${activeChat}`;
  if (chatKey && currentUser) {
    await fetch('/api/users/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser, chatKey, theme: themeName })
    });
  }
}

async function loadChatTheme(chatKey) {
  try {
    const res = await fetch(`/api/users/theme/${currentUser}/${chatKey}`);
    const data = await res.json();
    const theme = data.theme || 'default';
    currentChatTheme = theme;
    applyChatTheme(theme);
  } catch (e) {
    currentChatTheme = 'default';
    applyChatTheme('default');
  }
}

// ============ ENHANCED NEARBY (timed) ============

async function initVisibility() {
  try {
    const res = await fetch(`/api/users/visibility/${currentUser}`);
    const data = await res.json();
    isVisible = data.isVisible || false;
    updateVisibilityUI();
  } catch (e) {}
}

function updateVisibilityUI() {
  const visBtn = document.getElementById('visibility-btn');
  const visToggleBtn = document.getElementById('vis-toggle-btn');
  const visIcon = document.getElementById('vis-icon');
  const visLabel = document.getElementById('vis-label');
  const visDesc = document.getElementById('vis-desc');
  if (visBtn) {
    visBtn.style.background = isVisible ? '#00a884' : '#2a3942';
    visBtn.style.color = isVisible ? 'white' : '#8696a0';
  }
  if (visLabel) visLabel.textContent = isVisible ? '👁️ You are Visible' : '🙈 You are Hidden';
  if (visDesc) visDesc.textContent = isVisible
    ? 'Nearby users can discover you when they scan'
    : 'Turn on visibility so nearby users can discover you';
  if (visToggleBtn) {
    visToggleBtn.textContent = isVisible ? 'Turn Off' : 'Turn On';
    visToggleBtn.style.background = isVisible ? '#e53935' : '#00a884';
  }
}

async function toggleVisibility() {
  if (!isVisible) {
    if (!navigator.geolocation) return alert('Geolocation not supported');
    const duration = await pickVisibilityDuration();
    if (duration === null) return;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      isVisible = true;
      await fetch('/api/users/visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: currentUser,
          isVisible: true,
          lat: myLocation.lat,
          lng: myLocation.lng,
          durationMinutes: duration
        })
      });
      updateVisibilityUI();
      if (duration > 0) {
        setTimeout(() => { isVisible = false; updateVisibilityUI(); }, duration * 60 * 1000);
      }
    }, () => alert('Location permission required'));
  } else {
    isVisible = false;
    myLocation = null;
    await fetch('/api/users/visibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser, isVisible: false })
    });
    updateVisibilityUI();
  }
}

function pickVisibilityDuration() {
  return new Promise((resolve) => {
    const choice = window.prompt(
      'How long do you want to be visible?\n' +
      'Type:\n' +
      '1 → 15 minutes\n' +
      '2 → 1 hour\n' +
      '3 → Until I turn off\n'
    );
    if (choice === '1') resolve(15);
    else if (choice === '2') resolve(60);
    else if (choice === '3') resolve(0);
    else resolve(null);
  });
}

function openDiscover() {
  document.getElementById('discover-panel').classList.add('open');
  document.getElementById('discover-overlay').classList.add('open');
  updateVisibilityUI();
  document.getElementById('discover-results').innerHTML = '';
  document.getElementById('scan-status-msg').textContent = '';
}

function closeDiscover() {
  document.getElementById('discover-panel').classList.remove('open');
  document.getElementById('discover-overlay').classList.remove('open');
}

async function scanNearby() {
  const msg = document.getElementById('scan-status-msg');
  const results = document.getElementById('discover-results');
  msg.textContent = '📡 Scanning...';
  results.innerHTML = '';
  if (!navigator.geolocation) {
    msg.textContent = '❌ Geolocation not supported';
    return;
  }
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const res = await fetch('/api/users/nearby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: currentUser,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          radiusKm: 1
        })
      });
      const users = await res.json();
      if (users.length === 0) {
        msg.textContent = '📡 No visible users nearby';
        return;
      }
      msg.textContent = `Found ${users.length} user${users.length > 1 ? 's' : ''} nearby`;
      for (const u of users) {
        const div = document.createElement('div');
        div.className = 'search-result-item';
        div.style.cursor = 'pointer';
        div.innerHTML = `
          <span class="chat-list-initial" style="background:#00a884;">${u.username[0].toUpperCase()}</span>
          <div>
            <div style="color:#e9edef;font-size:15px;">📡 ${u.username}</div>
            <div style="color:#8696a0;font-size:12px;">${u.bio || 'Using priconkt'}</div>
          </div>
        `;
        div.onclick = () => { closeDiscover(); openPrivateChat(u.username); };
        results.appendChild(div);
      }
    } catch (err) {
      msg.textContent = '❌ Scan failed. Try again.';
    }
  }, () => {
    msg.textContent = '❌ Location permission denied.';
  });
}

// ============ VOICE MESSAGES ============
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let voiceRecognition = null;

async function startVoiceRecord(e) {
  if (e) e.preventDefault();
  if (isRecording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    isRecording = true;
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.start();
    const micBtn = document.getElementById('mic-btn');
    if (micBtn) {
      micBtn.textContent = '🔴';
      micBtn.style.color = '#e53935';
    }

    // Live transcription (Web Speech API)
    if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      voiceRecognition = new SpeechRecognition();
      voiceRecognition.continuous = true;
      voiceRecognition.interimResults = true;
      voiceRecognition.lang = 'en-IN';
      let transcript = '';
      voiceRecognition.onresult = (event) => {
        transcript = Array.from(event.results).map(r => r[0].transcript).join(' ');
        const input = document.getElementById('message-input');
        if (input && transcript) input.placeholder = '🎙️ ' + transcript;
      };
      voiceRecognition.start();
      voiceRecognition._lastTranscript = '';
      voiceRecognition.onend = () => {
        voiceRecognition._lastTranscript = transcript;
      };
    }
  } catch (err) {
    alert('Microphone permission required for voice messages.');
    isRecording = false;
  }
}

async function stopVoiceRecord(e) {
  if (e) e.preventDefault();
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  const micBtn = document.getElementById('mic-btn');
  if (micBtn) { micBtn.textContent = '🎙️'; micBtn.style.color = '#8696a0'; }
  const input = document.getElementById('message-input');
  if (input) input.placeholder = 'Type a message...';

  let transcript = '';
  if (voiceRecognition) {
    voiceRecognition.stop();
    transcript = voiceRecognition._lastTranscript || '';
    voiceRecognition = null;
  }

  mediaRecorder.onstop = async () => {
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    const duration = Math.round(audioChunks.length * 0.1);
    if (audioBlob.size < 1000) return;

    const formData = new FormData();
    formData.append('file', audioBlob, 'voice_' + Date.now() + '.webm');
    try {
      const res = await fetch('/api/media', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.fileUrl) {
        const tempId = 'temp_' + Date.now();
        showVoiceMessage(currentUser, data.fileUrl, transcript, new Date().toLocaleTimeString(), tempId, 'sent');
        if (activeChatType === 'private' && activeChat) {
          socket.emit('private_message', {
            receiver: activeChat, text: transcript || '',
            fileUrl: data.fileUrl, fileType: 'voice',
            fileName: transcript || 'Voice message'
          });
        } else if (activeChatType === 'group' && activeGroupId) {
          socket.emit('group_message', {
            groupId: activeGroupId, text: transcript || '',
            fileUrl: data.fileUrl, fileType: 'voice',
            fileName: transcript || 'Voice message'
          });
        }
      }
    } catch (err) { console.error('Voice upload failed:', err); }
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
  };
  mediaRecorder.stop();
}

function showVoiceMessage(sender, audioUrl, transcript, time, msgId, status) {
  const messages = document.getElementById('messages');
  const bubble = document.createElement('div');
  const isMine = sender === currentUser;
  bubble.className = isMine ? 'message-bubble sent' : 'message-bubble received';
  if (msgId) bubble.dataset.msgId = msgId;
  bubble.dataset.fileUrl = audioUrl;
  bubble.dataset.fileType = 'voice';
  bubble.dataset.isMine = isMine ? '1' : '0';
  bubble.dataset.msgSender = sender;
  bubble.dataset.status = status || 'sent';
  const dotsHtml = getDotsHtml(status, isMine);
  bubble.innerHTML = `
    <span class="sender">${sender}</span>
    <div class="voice-bubble">
      <button class="voice-play-btn" onclick="playVoice(this, '${audioUrl}')">▶</button>
      <div class="voice-wave">
        <div class="voice-bar"></div><div class="voice-bar"></div>
        <div class="voice-bar"></div><div class="voice-bar"></div>
        <div class="voice-bar"></div><div class="voice-bar"></div>
        <div class="voice-bar"></div><div class="voice-bar"></div>
      </div>
      <span class="voice-duration">🎙️</span>
    </div>
    ${transcript ? `<div class="voice-transcript">📝 ${transcript}</div>` : ''}
    <span class="time">${time}${dotsHtml}</span>
  `;
  if (!isMine) {
    bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, bubble);
    });
  }
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

let currentAudio = null;
function playVoice(btn, audioUrl) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  const audio = new Audio(audioUrl);
  currentAudio = audio;
  btn.textContent = '⏸';
  audio.play();
  audio.onended = () => { btn.textContent = '▶'; currentAudio = null; };
  audio.onerror = () => { btn.textContent = '▶'; };
}

// ============ UNIVERSAL TRANSLATION ============
let translateTo = '';

function setTranslateLang(lang) {
  translateTo = lang;
  const sel = document.getElementById('translate-lang');
  if (sel) sel.style.color = lang ? '#00a884' : '#8696a0';
  if (lang) translateVisibleMessages();
}

async function translateVisibleMessages() {
  if (!translateTo) return;
  const bubbles = document.querySelectorAll('.message-bubble.received');
  for (const bubble of bubbles) {
    if (bubble.querySelector('.translated-text')) continue;
    const textSpan = bubble.querySelector('.text');
    if (!textSpan) continue;
    const text = textSpan.textContent?.trim();
    if (!text || text.startsWith('[') || text.startsWith('🚫')) continue;
    const translated = await translateText(text, translateTo);
    if (translated) {
      const div = document.createElement('div');
      div.className = 'translated-text';
      div.textContent = '🌐 ' + translated;
      bubble.appendChild(div);
    }
    await new Promise(r => setTimeout(r, 400));
  }
}

// Override showMessage to add translate button on received messages
const _originalShowMessage = showMessage;
window._showMessageWithTranslate = async function(sender, text, time, msgId, isDeleted, fileUrl, fileType, fileName, replyTo, forwardedFrom, status) {
  _originalShowMessage(sender, text, time, msgId, isDeleted, fileUrl, fileType, fileName, replyTo, forwardedFrom, status);
  if (sender !== currentUser && text && !isDeleted && translateTo) {
    const bubble = msgId
      ? document.querySelector(`[data-msg-id="${msgId}"]`)
      : document.querySelector('.message-bubble.received:last-child');
    if (bubble) {
      const translated = await translateText(text, translateTo);
      if (translated && translated !== text) {
        const transDiv = document.createElement('div');
        transDiv.className = 'translated-text';
        transDiv.textContent = '🌐 ' + translated;
        const timeSpan = bubble.querySelector('.time');
        if (timeSpan) bubble.insertBefore(transDiv, timeSpan);
      }
    }
  }
};

async function translateVisibleMessages() {
  if (!translateTo) return;
  const bubbles = document.querySelectorAll('.message-bubble.received');
  for (const bubble of bubbles) {
    if (bubble.querySelector('.translated-text')) continue;
    const textSpan = bubble.querySelector('.text');
    const text = textSpan?.textContent;
    if (!text || text === '[old message]' || text.startsWith('🚫')) continue;
    const isEncrypted = text.length > 30 && !text.includes(' ') && /^[A-Za-z0-9+/=]+$/.test(text);
    if (isEncrypted) continue;
    try {
      const translated = await translateText(text, translateTo);
      if (translated && translated !== text) {
        const transDiv = document.createElement('div');
        transDiv.className = 'translated-text';
        transDiv.textContent = '🌐 ' + translated;
        const timeSpan = bubble.querySelector('.time');
        if (timeSpan) bubble.insertBefore(transDiv, timeSpan);
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
}

// ============ DELETE ACCOUNT ============
async function deleteAccount() {
  const confirm1 = confirm(
    '⚠️ Delete your account?\n\nThis will permanently delete:\n• Your account\n• All your messages\n• All your data\n\nThis CANNOT be undone!'
  );
  if (!confirm1) return;

  const confirm2 = confirm(
    '🚨 FINAL WARNING\n\nPress OK to permanently delete account: ' + currentUser
  );
  if (!confirm2) return;

  try {
    const res = await fetch('/api/auth/delete-account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser })
    });
    const data = await res.json();
    if (data.success) {
      alert('✅ Account deleted. Goodbye!');
      localStorage.clear();
      window.location.reload();
    } else {
      alert('❌ Error: ' + data.message);
    }
  } catch (err) {
    alert('❌ Failed to delete account. Try again.');
  }
}

// ============ LOGOUT ============
function logout() {
  const confirm1 = confirm('Are you sure you want to logout?');
  if (!confirm1) return;
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  currentUser = null;
  socket.emit('set_username', null);
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('auth-username').value = '';
  document.getElementById('auth-password').value = '';
}

// ============ MOBILE NAVIGATION ============
function goBackToChats() {
  closeSearch();
  closeDiscover();
  closeStatusTab();
  closePrivacyCenter();
  document.getElementById('sidebar').classList.remove('mobile-hidden');
  document.getElementById('chat-area').classList.remove('mobile-open');
  activeChat = null;
  activeChatType = null;
}

function applyMobileOpen() {
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.add('mobile-hidden');
    document.getElementById('chat-area').classList.add('mobile-open');
  }
}

// ============ CREATE GROUP FROM SEARCH ============
function openCreateGroupFromSearch() {
  const box = document.getElementById('create-group-inline');
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
  if (box.style.display === 'block') {
    document.getElementById('group-name-inline').focus();
    document.getElementById('search-results').innerHTML = '';
    document.getElementById('search-input').value = '';
  }
}

async function createGroupFromSearch() {
  const name = document.getElementById('group-name-inline').value.trim();
  if (!name) return alert('Enter a group name');
  const allUsers = await fetch('/api/users').then(r => r.json());
  const members = allUsers.map(u => u.username);
  if (!members.includes(currentUser)) members.push(currentUser);
  const res = await fetch('/api/groups/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, members, createdBy: currentUser })
  });
  const data = await res.json();
  document.getElementById('group-name-inline').value = '';
  document.getElementById('create-group-inline').style.display = 'none';
  closeSearch();
  loadGroups();
  alert('Group "' + name + '" created!');
}