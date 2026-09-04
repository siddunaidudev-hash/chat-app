let localStream = null;
let peerConnection = null;
let currentCallType = null;
let currentCallPeer = null;
let isMuted = false;
let isCameraOff = false;

const iceConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

async function startCall(callType) {
  if (!activeChat || activeChatType !== 'private') return;
  currentCallType = callType;
  currentCallPeer = activeChat;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video'
    });
    showCallScreen(currentUser, activeChat, callType);
    document.getElementById('local-video').srcObject = localStream;
    peerConnection = new RTCPeerConnection(iceConfig);
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        socket.emit('ice_candidate', { to: currentCallPeer, candidate: e.candidate });
      }
    };
    peerConnection.ontrack = e => {
      document.getElementById('remote-video').srcObject = e.streams[0];
    };
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('call_offer', { to: activeChat, offer, callType });
  } catch (err) {
    alert('Could not access camera/microphone: ' + err.message);
  }
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
      audio: true,
      video: currentCallType === 'video'
    });
    showCallScreen(currentUser, currentCallPeer, currentCallType);
    document.getElementById('local-video').srcObject = localStream;
    peerConnection = new RTCPeerConnection(iceConfig);
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        socket.emit('ice_candidate', { to: currentCallPeer, candidate: e.candidate });
      }
    };
    peerConnection.ontrack = e => {
      document.getElementById('remote-video').srcObject = e.streams[0];
    };
    await peerConnection.setRemoteDescription(window._pendingOffer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('call_answer', { to: currentCallPeer, answer });
  } catch (err) {
    alert('Could not access camera/microphone: ' + err.message);
  }
}

socket.on('call_answered', async ({ answer }) => {
  await peerConnection.setRemoteDescription(answer);
});

socket.on('ice_candidate', async ({ candidate }) => {
  if (peerConnection) await peerConnection.addIceCandidate(candidate);
});

function rejectCall() {
  socket.emit('call_reject', { to: currentCallPeer });
  document.getElementById('incoming-call').style.display = 'none';
}

socket.on('call_rejected', () => {
  alert(currentCallPeer + ' rejected the call');
  endCall();
});

socket.on('call_ended', () => {
  endCall();
});

function endCall() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (peerConnection) peerConnection.close();
  peerConnection = null;
  localStream = null;
  document.getElementById('call-screen').style.display = 'none';
  socket.emit('call_end', { to: currentCallPeer });
}

function showCallScreen(me, other, callType) {
  document.getElementById('call-screen').style.display = 'flex';
  document.getElementById('call-with-name').textContent =
    (callType === 'video' ? '📹' : '📞') + ' ' + other;
  if (callType === 'voice') {
    document.getElementById('local-video').style.display = 'none';
    document.getElementById('remote-video').style.display = 'none';
  }
}

function toggleMute() {
  isMuted = !isMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  }
  document.getElementById('mute-btn').textContent = isMuted ? '🔇 Unmute' : '🎙️ Mute';
}

function toggleCamera() {
  isCameraOff = !isCameraOff;
  if (localStream) {
    localStream.getVideoTracks().forEach(t => t.enabled = !isCameraOff);
  }
  document.getElementById('cam-btn').textContent = isCameraOff ? '📷 On' : '📷 Off';
}

// GROUP CALLS
let groupLocalStream = null;
let groupPeers = {};
let currentGroupCallId = null;

async function startGroupCall(callType) {
  if (!activeGroupId) return;
  currentGroupCallId = activeGroupId;
  try {
    groupLocalStream = await navigator.mediaDevices.getUserMedia({
      audio: true, video: callType === 'video'
    });
    const myVideo = document.createElement('video');
    myVideo.srcObject = groupLocalStream;
    myVideo.autoplay = true;
    myVideo.muted = true;
    myVideo.playsinline = true;
    myVideo.id = 'local-group-video';
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
  const pc = new RTCPeerConnection(iceConfig);
  groupPeers[username] = pc;
  groupLocalStream.getTracks().forEach(t => pc.addTrack(t, groupLocalStream));
  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('group_ice_candidate', { to: username, candidate: e.candidate });
    }
  };
  pc.ontrack = e => addGroupVideo(username, e.streams[0]);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('group_call_offer', { to: username, offer });
});

socket.on('group_call_offer', async ({ from, offer }) => {
  const pc = new RTCPeerConnection(iceConfig);
  groupPeers[from] = pc;
  groupLocalStream.getTracks().forEach(t => pc.addTrack(t, groupLocalStream));
  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('group_ice_candidate', { to: from, candidate: e.candidate });
    }
  };
  pc.ontrack = e => addGroupVideo(from, e.streams[0]);
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('group_call_answer', { to: from, answer });
});

socket.on('group_call_answer', async ({ from, answer }) => {
  if (groupPeers[from]) await groupPeers[from].setRemoteDescription(answer);
});

socket.on('group_ice_candidate', async ({ from, candidate }) => {
  if (groupPeers[from]) await groupPeers[from].addIceCandidate(candidate);
});

socket.on('group_call_user_left', ({ username }) => {
  const vid = document.getElementById('group-vid-' + username);
  if (vid) vid.remove();
  if (groupPeers[username]) {
    groupPeers[username].close();
    delete groupPeers[username];
  }
});

function addGroupVideo(username, stream) {
  const vid = document.createElement('video');
  vid.srcObject = stream;
  vid.autoplay = true;
  vid.playsinline = true;
  vid.id = 'group-vid-' + username;
  document.getElementById('group-videos').appendChild(vid);
}

function leaveGroupCall() {
  if (groupLocalStream) groupLocalStream.getTracks().forEach(t => t.stop());
  Object.values(groupPeers).forEach(pc => pc.close());
  groupPeers = {};
  groupLocalStream = null;
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