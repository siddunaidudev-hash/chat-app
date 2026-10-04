// ============ ICE CONFIG WITH FREE TURN SERVERS ============
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ],
  iceCandidatePoolSize: 10
};

let localStream = null;
let peerConnection = null;
let currentCallType = null;
let currentCallPeer = null;
let isMuted = false;
let isCameraOff = false;
let remoteStream = null;

// ============ HIGH QUALITY VIDEO CONSTRAINTS ============
function getMediaConstraints(callType) {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 1,
      latency: 0,
      volume: 1.0
    },
    video: callType === 'video' ? {
      width: { ideal: 1280, max: 1920 },
      height: { ideal: 720, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
      facingMode: 'user'
    } : false
  };
}

// ============ SAFE VIDEO PLAY (fixes mobile autoplay block) ============
async function safePlay(videoEl) {
  if (!videoEl) return;
  videoEl.muted = false;
  try {
    await videoEl.play();
  } catch (e) {
    // Mobile blocked autoplay — show tap-to-play overlay
    videoEl.muted = true;
    try { await videoEl.play(); } catch (e2) {}
  }
}

function setRemoteVideo(stream) {
  remoteStream = stream;
  const remoteVideo = document.getElementById('remote-video');
  if (!remoteVideo) return;
  remoteVideo.setAttribute('playsinline', '');
  remoteVideo.setAttribute('autoplay', '');
  remoteVideo.muted = false;
  remoteVideo.srcObject = stream;
  remoteVideo.style.display = 'block';
  remoteVideo.style.background = '#000';
  remoteVideo.onloadedmetadata = () => {
    safePlay(remoteVideo);
  };
  remoteVideo.onclick = () => safePlay(remoteVideo);
  safePlay(remoteVideo);
  // Retry play after 1 second in case autoplay blocked
  setTimeout(() => safePlay(remoteVideo), 1000);
  setTimeout(() => safePlay(remoteVideo), 3000);
}

// ============ CREATE PEER CONNECTION ============
function createPeerConnection() {
  const pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('ice_candidate', { to: currentCallPeer, candidate: e.candidate });
    }
  };

  pc.ontrack = e => {
    const stream = e.streams && e.streams[0] ? e.streams[0] : null;
    if (stream) {
      setRemoteVideo(stream);
    } else {
      // Build stream from tracks
      if (!remoteStream) remoteStream = new MediaStream();
      remoteStream.addTrack(e.track);
      setRemoteVideo(remoteStream);
    }
  };

  pc.onconnectionstatechange = () => {
    const nameEl = document.getElementById('call-with-name');
    if (pc.connectionState === 'connected') {
      if (nameEl) nameEl.style.color = '#00a884';
      boostAudioQuality(pc);
      if (currentCallType === 'video') boostVideoQuality(pc);
      // Boost audio quality after connection
      if (currentCallType === 'audio') boostAudioQuality(pc);
    } else if (pc.connectionState === 'failed') {
      alert('Call connection lost. Please try again.');
      endCall();
    }
  };

  pc.onicegatheringstatechange = () => console.log('ICE:', pc.iceGatheringState);
  return pc;
}

// ============ BOOST VIDEO BITRATE AFTER CONNECTION ============
function boostAudioQuality(pc) {
  try {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = 128000;
    sender.setParameters(params).catch(() => {});
  } catch (e) {}
}

function boostVideoQuality(pc) {
  try {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = 2500000;   // 2.5 Mbps
    params.encodings[0].maxFramerate = 30;
    params.encodings[0].scaleResolutionDownBy = 1.0;
    sender.setParameters(params).catch(() => {});
  } catch (e) {}
}

// ============ START CALL (Caller) ============
async function startCall(callType) {
  if (!activeChat || activeChatType !== 'private') return;
  currentCallType = callType;
  currentCallPeer = activeChat;
  remoteStream = null;
  try {
    localStream = await navigator.mediaDevices.getUserMedia(getMediaConstraints(callType));
    showCallScreen(currentUser, activeChat, callType);

    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    await safePlay(localVideo);

    peerConnection = createPeerConnection();
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    _callStartTime = Date.now();

    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: callType === 'video'
    });
    await peerConnection.setLocalDescription(offer);
    socket.emit('call_offer', { to: activeChat, offer, callType });
  } catch (err) {
    alert('Could not access camera/microphone: ' + err.message);
    endCall();
  }
}

// ============ INCOMING CALL ============
socket.on('incoming_call', async ({ from, offer, callType }) => {
  currentCallPeer = from;
  currentCallType = callType;
  remoteStream = null;
  document.getElementById('caller-name').textContent = (callType === 'video' ? '📹' : '📞') + ' ' + from + ' is calling...';
  document.getElementById('call-type-label').textContent = callType === 'video' ? '📹 Video Call' : '🎙️ Voice Call';
  document.getElementById('incoming-call').style.display = 'flex';
  window._pendingOffer = offer;
});

// ============ ANSWER CALL (Receiver) ============
async function answerCall() {
  document.getElementById('incoming-call').style.display = 'none';
  const peer = currentCallPeer;
  const callType = currentCallType;
  _callStartTime = Date.now();
  try {
    localStream = await navigator.mediaDevices.getUserMedia(getMediaConstraints(callType));
    showCallScreen(currentUser, peer, callType);

    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    await safePlay(localVideo);

    peerConnection = createPeerConnection();
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
   
    _callStartTime = Date.now();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(window._pendingOffer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('call_answer', { to: peer, answer });
  } catch (err) {
    alert('Could not access camera/microphone: ' + err.message);
    endCall();
  }
}

socket.on('call_answered', async ({ answer }) => {
  if (peerConnection) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

socket.on('ice_candidate', async ({ candidate }) => {
  if (peerConnection && candidate) {
    try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.log('ICE error:', e); }
  }
});

function rejectCall() {
  socket.emit('call_reject', { to: currentCallPeer });
  document.getElementById('incoming-call').style.display = 'none';
  currentCallPeer = null;
}

socket.on('call_rejected', () => { alert('Call rejected.'); endCall(); });
socket.on('call_ended', () => endCall());

let _callStartTime = null;
function endCall() {
  const peer = currentCallPeer;
  const type = currentCallType;

  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  remoteStream = null;
  const callScreen = document.getElementById('call-screen');
  if (callScreen) callScreen.style.display = 'none';
  const remoteVideo = document.getElementById('remote-video');
  if (remoteVideo) { remoteVideo.srcObject = null; }
  if (peer) socket.emit('call_end', { to: peer });
  currentCallPeer = null;
  isMuted = false; isCameraOff = false;
  const muteBtn = document.getElementById('mute-btn');
  const camBtn = document.getElementById('cam-btn');
  if (muteBtn) muteBtn.textContent = '🎙️ Mute';
  if (camBtn) camBtn.textContent = '📷 Camera';

  // Show call history in chat
  if (peer && activeChatType === 'private') {
    const duration = _callStartTime ? Math.floor((Date.now() - _callStartTime) / 1000) : 0;
    const mins = Math.floor(duration / 60);
    const secs = String(duration % 60).padStart(2, '0');
    const durationStr = duration > 0 ? ` — ${mins}:${secs}` : '';
    const callMsg = type === 'video'
      ? `📹 Video call${durationStr}`
      : `📞 Voice call${durationStr}`;
    showMessage(currentUser, callMsg, new Date().toLocaleTimeString(),
      'call_' + Date.now(), false, null, 'call', null, null, null, 'sent');
    socket.emit('private_message', {
      receiver: peer, text: callMsg, fileType: 'call', fileUrl: type
    });
  }
  _callStartTime = null;

  // Rejoin socket after call — fixes message delay after call
  setTimeout(() => {
    if (currentUser) socket.emit('set_username', currentUser);
    if (activeGroupId) socket.emit('join_group', activeGroupId);
    if (activeChat && activeChatType === 'private') {
      socket.emit('mark_read', { chatPartner: activeChat });
    }
  }, 800);
}

function showCallScreen(me, other, callType) {
  const callScreen = document.getElementById('call-screen');
  const localVideo = document.getElementById('local-video');
  const remoteVideo = document.getElementById('remote-video');
  callScreen.style.display = 'flex';
  document.getElementById('call-with-name').textContent = (callType === 'video' ? '📹' : '📞') + ' ' + other;
  const camBtn = document.getElementById('cam-btn');
  if (camBtn) camBtn.style.display = callType === 'video' ? 'flex' : 'none';
  if (callType === 'video') {
    localVideo.style.display = 'block';
    remoteVideo.style.display = 'block';
    // Style local video as small picture-in-picture
    localVideo.style.cssText = 'display:block;position:absolute;bottom:90px;right:12px;width:100px;height:140px;object-fit:cover;border-radius:12px;border:2px solid #00a884;z-index:10;';
    remoteVideo.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover;background:#000;';
  } else {
    localVideo.style.display = 'none';
    remoteVideo.style.display = 'none';
  }
}

function toggleMute() {
  isMuted = !isMuted;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  document.getElementById('mute-btn').textContent = isMuted ? '🔇 Unmute' : '🎙️ Mute';
}

function toggleCamera() {
  isCameraOff = !isCameraOff;
  if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = !isCameraOff);
  document.getElementById('cam-btn').textContent = isCameraOff ? '📷 On' : '📷 Off';
}

// ============ GROUP CALLS ============
let groupLocalStream = null;
let groupPeers = {};
let currentGroupCallId = null;

async function startGroupCall(callType) {
  if (!activeGroupId) return;
  currentGroupCallId = activeGroupId;
  try {
    groupLocalStream = await navigator.mediaDevices.getUserMedia(getMediaConstraints(callType));
    const myVideo = document.createElement('video');
    myVideo.srcObject = groupLocalStream;
    myVideo.autoplay = true; myVideo.muted = true; myVideo.playsInline = true;
    myVideo.id = 'local-group-video';
    await safePlay(myVideo);
    document.getElementById('group-videos').appendChild(myVideo);
    document.getElementById('group-call-title').textContent = (callType === 'video' ? '📹' : '📞') + ' Group Call';
    document.getElementById('group-call-screen').style.display = 'flex';
    socket.emit('group_call_join', { groupId: activeGroupId, callType });
  } catch (err) { alert('Could not access camera/microphone'); }
}

socket.on('group_call_user_joined', async ({ username }) => {
  if (!groupLocalStream) return;
  const pc = new RTCPeerConnection(iceConfig);
  groupPeers[username] = pc;
  groupLocalStream.getTracks().forEach(t => pc.addTrack(t, groupLocalStream));
  pc.onicecandidate = e => { if (e.candidate) socket.emit('group_ice_candidate', { to: username, candidate: e.candidate }); };
  pc.ontrack = e => addGroupVideo(username, e.streams[0] || (() => { const s = new MediaStream(); s.addTrack(e.track); return s; })());
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('group_call_offer', { to: username, offer });
});

socket.on('group_call_offer', async ({ from, offer }) => {
  if (!groupLocalStream) return;
  const pc = new RTCPeerConnection(iceConfig);
  groupPeers[from] = pc;
  groupLocalStream.getTracks().forEach(t => pc.addTrack(t, groupLocalStream));
  pc.onicecandidate = e => { if (e.candidate) socket.emit('group_ice_candidate', { to: from, candidate: e.candidate }); };
  pc.ontrack = e => addGroupVideo(from, e.streams[0] || (() => { const s = new MediaStream(); s.addTrack(e.track); return s; })());
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('group_call_answer', { to: from, answer });
});

socket.on('group_call_answer', async ({ from, answer }) => {
  if (groupPeers[from]) await groupPeers[from].setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('group_ice_candidate', async ({ from, candidate }) => {
  if (groupPeers[from] && candidate) {
    try { await groupPeers[from].addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
  }
});

socket.on('group_call_user_left', ({ username }) => {
  const vid = document.getElementById('group-vid-' + username);
  if (vid) vid.remove();
  if (groupPeers[username]) { groupPeers[username].close(); delete groupPeers[username]; }
});

function addGroupVideo(username, stream) {
  const vid = document.createElement('video');
  vid.srcObject = stream; vid.autoplay = true; vid.playsInline = true;
  vid.id = 'group-vid-' + username;
  safePlay(vid);
  document.getElementById('group-videos').appendChild(vid);
}

function leaveGroupCall() {
  if (groupLocalStream) groupLocalStream.getTracks().forEach(t => t.stop());
  Object.values(groupPeers).forEach(pc => pc.close());
  groupPeers = {}; groupLocalStream = null;
  document.getElementById('group-call-screen').style.display = 'none';
  document.getElementById('group-videos').innerHTML = '';
  socket.emit('group_call_leave', { groupId: currentGroupCallId });
}

function toggleGroupMute() {
  if (groupLocalStream) {
    const track = groupLocalStream.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      document.getElementById('group-mute-btn').textContent = track.enabled ? '🎙️ Mute' : '🔇 Unmute';
    }
  }
}