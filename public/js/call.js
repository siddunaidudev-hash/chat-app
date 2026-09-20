// ============ FREE TURN + STUN SERVERS (fixes mobile video/audio) ============
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turns:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

let localStream = null;
let peerConnection = null;
let currentCallType = null;
let currentCallPeer = null;
let isMuted = false;
let isCameraOff = false;

async function startCall(callType) {
  if (!activeChat || activeChatType !== 'private') return;
  currentCallType = callType;
  currentCallPeer = activeChat;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
      video: callType === 'video' ? { width: 640, height: 480, facingMode: 'user' } : false
    });
    showCallScreen(currentUser, activeChat, callType);
    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    await localVideo.play().catch(() => {});

    peerConnection = createPeerConnection();
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

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

function createPeerConnection() {
  const pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('ice_candidate', { to: currentCallPeer, candidate: e.candidate });
    }
  };

  pc.ontrack = e => {
    const remoteVideo = document.getElementById('remote-video');
    if (e.streams && e.streams[0]) {
      remoteVideo.srcObject = e.streams[0];
    } else {
      if (!remoteVideo.srcObject) remoteVideo.srcObject = new MediaStream();
      remoteVideo.srcObject.addTrack(e.track);
    }
    remoteVideo.play().catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    const nameEl = document.getElementById('call-with-name');
    if (state === 'connected') {
      if (nameEl) nameEl.style.color = '#00a884';
    } else if (state === 'failed' || state === 'disconnected') {
      if (nameEl) nameEl.style.color = '#e53935';
      alert('Call connection lost. Please try again.');
      endCall();
    }
  };

  pc.onicegatheringstatechange = () => {
    console.log('ICE gathering:', pc.iceGatheringState);
  };

  return pc;
}

socket.on('incoming_call', async ({ from, offer, callType }) => {
  currentCallPeer = from;
  currentCallType = callType;
  document.getElementById('caller-name').textContent = '📞 ' + from + ' is calling...';
  document.getElementById('call-type-label').textContent =
    callType === 'video' ? '📹 Video Call' : '🎙️ Voice Call';
  document.getElementById('incoming-call').style.display = 'flex';
  window._pendingOffer = offer;
});

async function answerCall() {
  document.getElementById('incoming-call').style.display = 'none';
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
      video: currentCallType === 'video' ? { width: 640, height: 480, facingMode: 'user' } : false
    });
    showCallScreen(currentUser, currentCallPeer, currentCallType);
    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    await localVideo.play().catch(() => {});

    peerConnection = createPeerConnection();
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

    await peerConnection.setRemoteDescription(new RTCSessionDescription(window._pendingOffer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('call_answer', { to: currentCallPeer, answer });
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
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) { console.log('ICE error:', e); }
  }
});

function rejectCall() {
  socket.emit('call_reject', { to: currentCallPeer });
  document.getElementById('incoming-call').style.display = 'none';
  currentCallPeer = null;
}

socket.on('call_rejected', () => {
  alert(currentCallPeer + ' rejected the call.');
  endCall();
});

socket.on('call_ended', () => endCall());

function endCall() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  const callScreen = document.getElementById('call-screen');
  if (callScreen) callScreen.style.display = 'none';
  if (currentCallPeer) socket.emit('call_end', { to: currentCallPeer });
  currentCallPeer = null;
  isMuted = false; isCameraOff = false;
  const muteBtn = document.getElementById('mute-btn');
  const camBtn = document.getElementById('cam-btn');
  if (muteBtn) muteBtn.textContent = '🎙️ Mute';
  if (camBtn) camBtn.textContent = '📷 Camera';
}

function showCallScreen(me, other, callType) {
  const callScreen = document.getElementById('call-screen');
  const localVideo = document.getElementById('local-video');
  const remoteVideo = document.getElementById('remote-video');
  callScreen.style.display = 'flex';
  document.getElementById('call-with-name').textContent =
    (callType === 'video' ? '📹' : '📞') + ' ' + other;
  if (callType === 'video') {
    localVideo.style.display = 'block';
    remoteVideo.style.display = 'block';
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
    groupLocalStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: callType === 'video'
    });
    const myVideo = document.createElement('video');
    myVideo.srcObject = groupLocalStream;
    myVideo.autoplay = true; myVideo.muted = true; myVideo.playsinline = true;
    myVideo.id = 'local-group-video';
    myVideo.play().catch(() => {});
    document.getElementById('group-videos').appendChild(myVideo);
    document.getElementById('group-call-title').textContent =
      (callType === 'video' ? '📹' : '📞') + ' Group Call';
    document.getElementById('group-call-screen').style.display = 'flex';
    socket.emit('group_call_join', { groupId: activeGroupId, callType });
  } catch (err) {
    alert('Could not access camera/microphone');
  }
}

socket.on('group_call_user_joined', async ({ username }) => {
  if (!groupLocalStream) return;
  const pc = new RTCPeerConnection(iceConfig);
  groupPeers[username] = pc;
  groupLocalStream.getTracks().forEach(t => pc.addTrack(t, groupLocalStream));
  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('group_ice_candidate', { to: username, candidate: e.candidate });
  };
  pc.ontrack = e => addGroupVideo(username, e.streams[0] || new MediaStream([e.track]));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('group_call_offer', { to: username, offer });
});

socket.on('group_call_offer', async ({ from, offer }) => {
  if (!groupLocalStream) return;
  const pc = new RTCPeerConnection(iceConfig);
  groupPeers[from] = pc;
  groupLocalStream.getTracks().forEach(t => pc.addTrack(t, groupLocalStream));
  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('group_ice_candidate', { to: from, candidate: e.candidate });
  };
  pc.ontrack = e => addGroupVideo(from, e.streams[0] || new MediaStream([e.track]));
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
  vid.srcObject = stream; vid.autoplay = true; vid.playsinline = true;
  vid.id = 'group-vid-' + username;
  vid.play().catch(() => {});
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
      document.getElementById('group-mute-btn').textContent =
        track.enabled ? '🎙️ Mute' : '🔇 Unmute';
    }
  }
}