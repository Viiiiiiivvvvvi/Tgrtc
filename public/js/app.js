/**
 * TGRTC Demo Application
 */

// DOM Elements
const loginContainer = document.getElementById('loginContainer');
const roomContainer = document.getElementById('roomContainer');
const userIdInput = document.getElementById('userId');
const roomIdInput = document.getElementById('roomId');
const roleSelect = document.getElementById('roleSelect');
const joinBtn = document.getElementById('joinBtn');
const toggleVideoBtn = document.getElementById('toggleVideoBtn');
const toggleAudioBtn = document.getElementById('toggleAudioBtn');
const switchRoleBtn = document.getElementById('switchRoleBtn');
const leaveBtn = document.getElementById('leaveBtn');
const roomIdDisplay = document.getElementById('roomIdDisplay');
const localVideo = document.getElementById('localVideo');
const videoGrid = document.getElementById('videoGrid');
const participantsList = document.getElementById('participantsList');

// State variables
let tgrtc = null;
let isVideoEnabled = false;
let isAudioEnabled = false;
let currentRole = '';
let participants = new Map();
let connectionStatus = new Map(); // Track connection status for each participant

// Initialize TGRTC
function initTGRTC() {
  tgrtc = TGRTC.create();
  
  // Set up event listeners
  tgrtc.on(TGRTC.EVENT.ERROR, handleError);
  tgrtc.on(TGRTC.EVENT.ROOM_CREATED, handleRoomCreated);
  tgrtc.on(TGRTC.EVENT.ROOM_JOINED, handleRoomJoined);
  tgrtc.on(TGRTC.EVENT.USER_JOINED, handleUserJoined);
  tgrtc.on(TGRTC.EVENT.USER_LEFT, handleUserLeft);
  tgrtc.on(TGRTC.EVENT.ROLE_SWITCHED, handleRoleSwitched);
  tgrtc.on(TGRTC.EVENT.REMOTE_VIDEO_AVAILABLE, handleRemoteVideoAvailable);
  tgrtc.on(TGRTC.EVENT.REMOTE_STREAM_UNAVAILABLE, handleRemoteStreamUnavailable);
  tgrtc.on(TGRTC.EVENT.RELAY_MODE, handleRelayMode);
}

// Event Handlers
function handleError(error) {
  console.error('TGRTC Error:', error);
  alert(`Error: ${error.message || error.code}`);
}

function handleRelayMode(data) {
  console.log('Relay mode activated for:', data.userId);
  updateConnectionStatus(data.userId, 'relay');
}

function handleRoomCreated(data) {
  console.log('Room created:', data);
  showRoom(data);
}

function handleRoomJoined(data) {
  console.log('Room joined:', data);
  showRoom(data);
}

function handleUserJoined(data) {
  console.log('User joined:', data);
  addParticipant(data.userId, data.isAnchor);
}

function handleUserLeft(data) {
  console.log('User left:', data);
  removeParticipant(data.userId);
}

function handleRoleSwitched(data) {
  console.log('Role switched:', data);
  updateParticipantRole(data.userId, data.isAnchor);
  
  if (data.userId === userIdInput.value) {
    currentRole = data.isAnchor ? TGRTC.TYPE.ROLE_ANCHOR : TGRTC.TYPE.ROLE_AUDIENCE;
    updateUIForRole();
  }
}

function handleRemoteVideoAvailable(data) {
  console.log('Remote video available:', data);
  createRemoteVideoElement(data.userId);
  
  // Update connection status
  connectionStatus.set(data.userId, 'connected');
  updateConnectionStatus(data.userId, 'connected');
}

function handleRemoteStreamUnavailable(data) {
  console.log('Remote stream unavailable:', data);
  removeRemoteVideoElement(data.userId);
  
  // Update connection status
  connectionStatus.delete(data.userId);
}

// UI Functions
function showRoom(data) {
  loginContainer.classList.add('hidden');
  roomContainer.classList.remove('hidden');
  
  roomIdDisplay.textContent = data.roomId;
  currentRole = data.isAnchor ? TGRTC.TYPE.ROLE_ANCHOR : TGRTC.TYPE.ROLE_AUDIENCE;
  
  // Clear previous participants
  participantsList.innerHTML = '';
  videoGrid.querySelectorAll('.remote-video').forEach(el => el.remove());
  
  // Add current participants
  if (data.participants) {
    data.participants.forEach(participant => {
      addParticipant(participant.id, participant.isAnchor);
    });
  }
  
  updateUIForRole();
  
  // Start local media if anchor
  if (data.isAnchor) {
    startLocalVideo();
    startLocalAudio();
  }
}

function updateUIForRole() {
  const isAnchor = currentRole === TGRTC.TYPE.ROLE_ANCHOR;
  
  // Update switch role button
  switchRoleBtn.textContent = isAnchor ? 'Switch to Audience' : 'Switch to Anchor';
  
  // Show/hide media controls based on role
  toggleVideoBtn.disabled = !isAnchor;
  toggleAudioBtn.disabled = !isAnchor;
  
  // Update local video visibility
  document.querySelector('.local-video').style.display = isAnchor ? 'block' : 'none';
}

function addParticipant(userId, isAnchor) {
  if (userId === userIdInput.value) return; // Skip self
  
  participants.set(userId, { id: userId, isAnchor });
  
  // Add to participants list
  const li = document.createElement('li');
  li.id = `participant-${userId}`;
  li.innerHTML = `${userId} (${isAnchor ? 'Anchor' : 'Audience'}) <span class="connection-status">connecting...</span>`;
  participantsList.appendChild(li);
  
  // Set initial connection status
  connectionStatus.set(userId, 'connecting');
  
  // Create video element if participant is anchor
  if (isAnchor) {
    createRemoteVideoElement(userId);
  }
}

function updateParticipantRole(userId, isAnchor) {
  if (userId === userIdInput.value) return; // Skip self
  
  const participant = participants.get(userId);
  if (participant) {
    participant.isAnchor = isAnchor;
    
    // Update participant list
    const li = document.getElementById(`participant-${userId}`);
    if (li) {
      const status = connectionStatus.get(userId) || 'connecting';
      li.innerHTML = `${userId} (${isAnchor ? 'Anchor' : 'Audience'}) <span class="connection-status">${status}</span>`;
    }
    
    // Create or remove video element based on role
    if (isAnchor) {
      createRemoteVideoElement(userId);
    } else {
      removeRemoteVideoElement(userId);
    }
  }
}

// Update connection status for a participant
function updateConnectionStatus(userId, status) {
  connectionStatus.set(userId, status);
  
  const li = document.getElementById(`participant-${userId}`);
  if (li) {
    const statusSpan = li.querySelector('.connection-status');
    if (statusSpan) {
      statusSpan.textContent = status;
      statusSpan.className = `connection-status ${status}`;
    }
  }
}

function removeParticipant(userId) {
  participants.delete(userId);
  connectionStatus.delete(userId);
  
  // Remove from participants list
  const li = document.getElementById(`participant-${userId}`);
  if (li) {
    li.remove();
  }
  
  // Remove video element
  removeRemoteVideoElement(userId);
}

function createRemoteVideoElement(userId) {
  // Check if element already exists
  if (document.getElementById(`remote-video-${userId}`)) {
    return;
  }
  
  // Create video container
  const videoItem = document.createElement('div');
  videoItem.className = 'video-item remote-video';
  videoItem.id = `remote-video-container-${userId}`;
  
  // Create video element
  const video = document.createElement('video');
  video.id = `remote-video-${userId}`;
  video.autoplay = true;
  // Fix Firefox compatibility issue by setting playsinline as a property instead of attribute
  video.setAttribute('playsinline', ''); // For Safari/Chrome
  video.playsInline = true; // For other browsers
  
  // Create label
  const label = document.createElement('div');
  label.className = 'video-label';
  label.textContent = userId;
  
  // Append elements
  videoItem.appendChild(video);
  videoItem.appendChild(label);
  videoGrid.appendChild(videoItem);
  
  // Start remote video
  tgrtc.startRemoteVideo({
    userId,
    element: video
  }).catch(error => {
    console.error('Failed to start remote video:', error);
  });
}

function removeRemoteVideoElement(userId) {
  const videoContainer = document.getElementById(`remote-video-container-${userId}`);
  if (videoContainer) {
    videoContainer.remove();
  }
}

// Media Functions
async function startLocalVideo() {
  try {
    await tgrtc.startLocalVideo({
      element: localVideo,
      constraints: { video: true }
    });
    
    isVideoEnabled = true;
    toggleVideoBtn.textContent = 'Stop Video';
  } catch (error) {
    console.error('Failed to start local video:', error);
    alert('Failed to start camera: ' + error.message);
  }
}

async function stopLocalVideo() {
  try {
    await tgrtc.stopLocalVideo();
    
    isVideoEnabled = false;
    toggleVideoBtn.textContent = 'Start Video';
  } catch (error) {
    console.error('Failed to stop local video:', error);
  }
}

async function startLocalAudio() {
  try {
    await tgrtc.startLocalAudio({
      constraints: { audio: true }
    });
    
    isAudioEnabled = true;
    toggleAudioBtn.textContent = 'Stop Audio';
  } catch (error) {
    console.error('Failed to start local audio:', error);
    alert('Failed to start microphone: ' + error.message);
  }
}

async function stopLocalAudio() {
  try {
    await tgrtc.stopLocalAudio();
    
    isAudioEnabled = false;
    toggleAudioBtn.textContent = 'Start Audio';
  } catch (error) {
    console.error('Failed to stop local audio:', error);
  }
}

// Event Listeners
joinBtn.addEventListener('click', async () => {
  const userId = userIdInput.value.trim();
  const roomId = roomIdInput.value.trim() || null; // null will create a new room
  const role = roleSelect.value;
  const isAnchor = role === TGRTC.TYPE.ROLE_ANCHOR;
  
  if (!userId) {
    alert('Please enter a user ID');
    return;
  }
  
  try {
    // Initialize TGRTC if not already
    if (!tgrtc) {
      initTGRTC();
    }
    
    // Enter room
    await tgrtc.enterRoom({
      roomId,
      userId,
      isAnchor
    });
  } catch (error) {
    console.error('Failed to join room:', error);
    alert('Failed to join room: ' + error.message);
  }
});

toggleVideoBtn.addEventListener('click', async () => {
  if (isVideoEnabled) {
    await stopLocalVideo();
  } else {
    await startLocalVideo();
  }
});

toggleAudioBtn.addEventListener('click', async () => {
  if (isAudioEnabled) {
    await stopLocalAudio();
  } else {
    await startLocalAudio();
  }
});

switchRoleBtn.addEventListener('click', async () => {
  const newRole = currentRole === TGRTC.TYPE.ROLE_ANCHOR ? TGRTC.TYPE.ROLE_AUDIENCE : TGRTC.TYPE.ROLE_ANCHOR;
  
  try {
    await tgrtc.switchRole({
      isAnchor: newRole === TGRTC.TYPE.ROLE_ANCHOR
    });
    
    // If switching to audience, stop local media
    if (newRole === TGRTC.TYPE.ROLE_AUDIENCE) {
      if (isVideoEnabled) await stopLocalVideo();
      if (isAudioEnabled) await stopLocalAudio();
    } else {
      // If switching to anchor, start local media
      await startLocalVideo();
      await startLocalAudio();
    }
  } catch (error) {
    console.error('Failed to switch role:', error);
    alert('Failed to switch role: ' + error.message);
  }
});

leaveBtn.addEventListener('click', async () => {
  try {
    await tgrtc.exitRoom();
    
    // Reset UI
    loginContainer.classList.remove('hidden');
    roomContainer.classList.add('hidden');
    
    // Reset state
    isVideoEnabled = false;
    isAudioEnabled = false;
    participants.clear();
    
    // Clean up TGRTC
    tgrtc = null;
  } catch (error) {
    console.error('Failed to leave room:', error);
    alert('Failed to leave room: ' + error.message);
  }
});
