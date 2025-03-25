const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const wrtc = require('wrtc'); // For server-side WebRTC

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store active rooms
const rooms = new Map();

// Store server-side peer connections for relay
const relayConnections = new Map(); // roomId_userId -> { pc, streams }

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Handle room creation
  socket.on('create-room', ({ userId, roomId = null, isAnchor = true }) => {
    // Generate room ID if not provided
    const newRoomId = roomId || uuidv4();
    
    // Create or update room
    if (!rooms.has(newRoomId)) {
      rooms.set(newRoomId, {
        id: newRoomId,
        anchor: isAnchor ? userId : null,
        participants: new Map()
      });
    }
    
    const room = rooms.get(newRoomId);
    
    // Add participant to room
    room.participants.set(userId, {
      id: userId,
      socketId: socket.id,
      isAnchor: isAnchor
    });
    
    // Join socket room
    socket.join(newRoomId);
    
    // Send room info to client
    socket.emit('room-created', {
      roomId: newRoomId,
      userId,
      isAnchor,
      participants: Array.from(room.participants.values())
    });
    
    // Notify other participants
    socket.to(newRoomId).emit('user-joined', {
      userId,
      isAnchor
    });
    
    console.log(`User ${userId} created/joined room ${newRoomId}`);
  });

  // Handle room joining
  socket.on('join-room', ({ userId, roomId, isAnchor = false }) => {
    // Check if room exists
    if (!rooms.has(roomId)) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    const room = rooms.get(roomId);
    
    // Add participant to room
    room.participants.set(userId, {
      id: userId,
      socketId: socket.id,
      isAnchor: isAnchor
    });
    
    // Join socket room
    socket.join(roomId);
    
    // Send room info to client
    socket.emit('room-joined', {
      roomId,
      userId,
      isAnchor,
      participants: Array.from(room.participants.values())
    });
    
    // Notify other participants
    socket.to(roomId).emit('user-joined', {
      userId,
      isAnchor
    });
    
    console.log(`User ${userId} joined room ${roomId}`);
  });

  // Handle WebRTC signaling
  socket.on('offer', ({ roomId, userId, targetId, sdp, useRelay = false }) => {
    const targetSocket = rooms.get(roomId)?.participants.get(targetId)?.socketId;
    
    if (useRelay) {
      // Handle relay mode
      handleRelayOffer(roomId, userId, targetId, sdp, socket);
    } else {
      // Direct peer-to-peer mode
      io.to(targetSocket).emit('offer', {
        userId,
        sdp
      });
    }
  });

  socket.on('answer', ({ roomId, userId, targetId, sdp, useRelay = false }) => {
    const targetSocket = rooms.get(roomId)?.participants.get(targetId)?.socketId;
    
    if (useRelay) {
      // Handle relay mode
      handleRelayAnswer(roomId, userId, targetId, sdp, socket);
    } else {
      // Direct peer-to-peer mode
      io.to(targetSocket).emit('answer', {
        userId,
        sdp
      });
    }
  });

  socket.on('ice-candidate', ({ roomId, userId, targetId, candidate, useRelay = false }) => {
    const targetSocket = rooms.get(roomId)?.participants.get(targetId)?.socketId;
    
    if (useRelay) {
      // Handle relay mode
      handleRelayIceCandidate(roomId, userId, targetId, candidate, socket);
    } else {
      // Direct peer-to-peer mode
      io.to(targetSocket).emit('ice-candidate', {
        userId,
        candidate
      });
    }
  });

  // Handle role switching (audience to anchor or vice versa)
  socket.on('switch-role', ({ roomId, userId, isAnchor }) => {
    if (!rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    const participant = room.participants.get(userId);
    
    if (participant) {
      participant.isAnchor = isAnchor;
      io.to(roomId).emit('role-switched', { userId, isAnchor });
    }
  });

  // Handle user leaving
  socket.on('leave-room', ({ roomId, userId }) => {
    handleUserLeaving(roomId, userId);
  });

  // Request to use relay
  socket.on('request-relay', ({ roomId, userId, targetId }) => {
    console.log(`Relay requested from ${userId} to ${targetId} in room ${roomId}`);
    
    // Notify target user to switch to relay mode
    const targetSocket = rooms.get(roomId)?.participants.get(targetId)?.socketId;
    if (targetSocket) {
      io.to(targetSocket).emit('use-relay', { userId });
    }
    
    // Notify requesting user that relay is ready
    socket.emit('relay-ready', { targetId });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    
    // Find and remove user from all rooms
    rooms.forEach((room, roomId) => {
      room.participants.forEach((participant, userId) => {
        if (participant.socketId === socket.id) {
          handleUserLeaving(roomId, userId);
        }
      });
    });
  });

  // Helper function to handle user leaving
  function handleUserLeaving(roomId, userId) {
    if (!rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    
    // Remove participant from room
    room.participants.delete(userId);
    
    // Notify other participants
    socket.to(roomId).emit('user-left', { userId });
    
    console.log(`User ${userId} left room ${roomId}`);
    
    // Clean up relay connections for this user
    cleanupRelayConnections(roomId, userId);
    
    // Clean up empty rooms
    if (room.participants.size === 0) {
      rooms.delete(roomId);
      console.log(`Room ${roomId} deleted (empty)`);
    }
  }
});

// Relay handling functions
async function handleRelayOffer(roomId, senderId, receiverId, sdp, socket) {
  const relayKeyA = `${roomId}_${senderId}_${receiverId}`; // Sender to receiver
  const relayKeyB = `${roomId}_${receiverId}_${senderId}`; // Receiver to sender
  
  // Create server-side peer connection for sender if it doesn't exist
  if (!relayConnections.has(relayKeyA)) {
    const pcSender = new wrtc.RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
    
    relayConnections.set(relayKeyA, {
      pc: pcSender,
      streams: new Map()
    });
    
    // Handle ICE candidates from sender's PC
    pcSender.onicecandidate = (event) => {
      if (event.candidate) {
        // Send ICE candidate to sender
        socket.emit('ice-candidate', {
          userId: receiverId, // Pretend it's from the receiver
          candidate: event.candidate
        });
      }
    };
    
    // Handle tracks from sender to relay to receiver
    pcSender.ontrack = (event) => {
      const relayInfo = relayConnections.get(relayKeyA);
      const stream = event.streams[0];
      
      // Store the stream
      relayInfo.streams.set(event.track.id, {
        stream,
        track: event.track
      });
      
      // If we have a connection to the receiver, add this track
      if (relayConnections.has(relayKeyB)) {
        const receiverPC = relayConnections.get(relayKeyB).pc;
        receiverPC.addTrack(event.track, stream);
        
        // Create a new offer to send to the receiver
        receiverPC.createOffer()
          .then(offer => receiverPC.setLocalDescription(offer))
          .then(() => {
            const receiverSocket = rooms.get(roomId)?.participants.get(receiverId)?.socketId;
            if (receiverSocket) {
              io.to(receiverSocket).emit('offer', {
                userId: senderId, // Pretend it's from the sender
                sdp: receiverPC.localDescription
              });
            }
          })
          .catch(err => console.error('Error creating relay offer:', err));
      }
    };
  }
  
  // Get the sender's peer connection
  const senderRelay = relayConnections.get(relayKeyA);
  
  // Set the remote description (offer from sender)
  try {
    await senderRelay.pc.setRemoteDescription(new wrtc.RTCSessionDescription(sdp));
    
    // Create answer
    const answer = await senderRelay.pc.createAnswer();
    await senderRelay.pc.setLocalDescription(answer);
    
    // Send answer back to sender
    socket.emit('answer', {
      userId: receiverId, // Pretend it's from the receiver
      sdp: senderRelay.pc.localDescription
    });
  } catch (error) {
    console.error('Error handling relay offer:', error);
  }
}

async function handleRelayAnswer(roomId, senderId, receiverId, sdp, socket) {
  const relayKey = `${roomId}_${receiverId}_${senderId}`; // Receiver to sender relay
  
  if (relayConnections.has(relayKey)) {
    const relay = relayConnections.get(relayKey);
    
    try {
      // Set the remote description (answer from receiver)
      await relay.pc.setRemoteDescription(new wrtc.RTCSessionDescription(sdp));
    } catch (error) {
      console.error('Error handling relay answer:', error);
    }
  }
}

async function handleRelayIceCandidate(roomId, senderId, receiverId, candidate, socket) {
  const relayKey = `${roomId}_${receiverId}_${senderId}`; // Direction is important
  
  if (relayConnections.has(relayKey)) {
    const relay = relayConnections.get(relayKey);
    
    try {
      await relay.pc.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
    } catch (error) {
      console.error('Error handling relay ICE candidate:', error);
    }
  }
}

function cleanupRelayConnections(roomId, userId) {
  // Find and close all relay connections involving this user
  for (const [key, relay] of relayConnections.entries()) {
    if (key.includes(`${roomId}_${userId}`)) {
      // Close the peer connection
      relay.pc.close();
      
      // Remove from map
      relayConnections.delete(key);
      
      console.log(`Cleaned up relay connection: ${key}`);
    }
  }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
