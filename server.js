const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const wrtc = require('wrtc');

// HTTPS options
const options = {
  key: fs.readFileSync(path.join(__dirname, 'ssl/key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'ssl/cert.pem'))
};

const app = express();
const server = https.createServer(options, app);
const io = socketIo(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store active rooms
const rooms = new Map();

// Store SFU connections
const sfuConnections = new Map(); // roomId -> { publishers: Map<userId, {pc, stream}>, subscribers: Map<userId, Map<targetId, pc>> }

// Helper function to create peer connection
function createPeerConnection(userId, roomId) {
  const pc = new wrtc.RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: 'turn:208.83.236.198:3478',
        username: 'vicky',
        credential: 'vicky1022'
      }
    ]
  });
  
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      const room = rooms.get(roomId);
      const participant = room.participants.get(userId);
      if (participant) {
        io.to(participant.socketId).emit('sfu-ice-candidate', {
          candidate,
          userId
        });
      }
    }
  };

  return pc;
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Handle room creation
  socket.on('create-room', ({ userId, roomId = null, isAnchor = true }) => {
    const newRoomId = roomId || uuidv4();
    
    if (!rooms.has(newRoomId)) {
      rooms.set(newRoomId, {
        id: newRoomId,
        anchor: isAnchor ? userId : null,
        participants: new Map()
      });
      
      // Initialize SFU connections for the room
      sfuConnections.set(newRoomId, {
        publishers: new Map(),
        subscribers: new Map()
      });
    }
    
    const room = rooms.get(newRoomId);
    
    room.participants.set(userId, {
      id: userId,
      socketId: socket.id,
      isAnchor: isAnchor
    });
    
    socket.join(newRoomId);
    
    socket.emit('room-created', {
      roomId: newRoomId,
      userId,
      isAnchor
    });
  });

  // Handle joining existing room
  socket.on('join-room', ({ roomId, userId, isAnchor = false }) => {
    console.log(`User ${userId} joining room ${roomId}`);
    
    // Check if room exists
    if (!rooms.has(roomId)) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    const room = rooms.get(roomId);
    
    // Add user to room participants
    room.participants.set(userId, {
      id: userId,
      socketId: socket.id,
      isAnchor: isAnchor
    });
    
    // Join the socket.io room
    socket.join(roomId);
    
    // Notify the user they've joined the room
    socket.emit('room-joined', {
      roomId,
      userId,
      isAnchor,
      participants: Array.from(room.participants.entries())
        .filter(([id]) => id !== userId)
        .map(([id, participant]) => ({
          id,
          isAnchor: participant.isAnchor
        }))
    });
    
    // Notify other participants that a new user has joined
    socket.to(roomId).emit('user-joined', {
      userId,
      isAnchor
    });
    
    // If there are publishers in the room, set up subscriptions for the new user
    const sfuRoom = sfuConnections.get(roomId);
    if (sfuRoom && sfuRoom.publishers.size > 0) {
      sfuRoom.publishers.forEach((publisher, publisherId) => {
        if (publisherId !== userId && publisher.stream) {
          handleSubscription(roomId, userId, publisherId);
        }
      });
    }
  });

  // Handle WebRTC offer
  socket.on('offer', async ({ roomId, userId, targetId, sdp }) => {
    console.log(`Received offer from ${userId} to ${targetId}`);
    
    const room = rooms.get(roomId);
    if (!room) return;
    
    const targetParticipant = room.participants.get(targetId);
    if (!targetParticipant) return;
    
    // Forward the offer to the target user
    io.to(targetParticipant.socketId).emit('offer', {
      roomId,
      userId,
      sdp
    });
  });
  
  // Handle WebRTC answer
  socket.on('answer', async ({ roomId, userId, targetId, sdp }) => {
    console.log(`Received answer from ${userId} to ${targetId}`);
    
    const room = rooms.get(roomId);
    if (!room) return;
    
    const targetParticipant = room.participants.get(targetId);
    if (!targetParticipant) return;
    
    // Forward the answer to the target user
    io.to(targetParticipant.socketId).emit('answer', {
      roomId,
      userId,
      sdp
    });
  });
  
  // Handle ICE candidates
  socket.on('ice-candidate', async ({ roomId, userId, targetId, candidate }) => {
    console.log(`Received ICE candidate from ${userId} to ${targetId}`);
    
    const room = rooms.get(roomId);
    if (!room) return;
    
    const targetParticipant = room.participants.get(targetId);
    if (!targetParticipant) return;
    
    // Forward the ICE candidate to the target user
    io.to(targetParticipant.socketId).emit('ice-candidate', {
      roomId,
      userId,
      candidate
    });
  });
  
  // Handle connection restart requests
  socket.on('restart-request', async ({ roomId, userId, targetId }) => {
    console.log(`Received restart request from ${userId} to ${targetId}`);
    
    const room = rooms.get(roomId);
    if (!room) return;
    
    const targetParticipant = room.participants.get(targetId);
    if (!targetParticipant) return;
    
    // Forward the restart request to the target user
    io.to(targetParticipant.socketId).emit('restart-connection', {
      roomId,
      userId,
      targetId: userId // The requester becomes the target for the response
    });
  });
  
  // Handle publishing stream to SFU
  socket.on('publish', async ({ roomId, userId, sdp }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const sfuRoom = sfuConnections.get(roomId);
    if (!sfuRoom) return;

    let publisher = sfuRoom.publishers.get(userId);
    
    if (!publisher) {
      const pc = createPeerConnection(userId, roomId);
      
      pc.ontrack = ({ track, streams }) => {
        const stream = streams[0];
        sfuRoom.publishers.set(userId, { pc, stream });
        
        // Forward the new stream to all existing subscribers
        room.participants.forEach((participant, participantId) => {
          if (participantId !== userId) {
            handleSubscription(roomId, participantId, userId);
          }
        });
      };

      try {
        await pc.setRemoteDescription(new wrtc.RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        socket.emit('sfu-answer', {
          sdp: pc.localDescription,
          userId
        });
        
        sfuRoom.publishers.set(userId, { pc });
      } catch (error) {
        console.error('Error handling publish:', error);
      }
    }
  });

  // Handle subscribing to a stream
  socket.on('subscribe', async ({ roomId, userId, targetId }) => {
    handleSubscription(roomId, userId, targetId);
  });

  // Handle ICE candidates for SFU
  socket.on('ice-candidate', ({ roomId, userId, targetId, candidate }) => {
    const sfuRoom = sfuConnections.get(roomId);
    if (!sfuRoom) return;

    if (targetId) {
      // Subscriber ICE candidate
      const subscribers = sfuRoom.subscribers.get(userId);
      if (subscribers) {
        const pc = subscribers.get(targetId);
        if (pc) {
          pc.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
        }
      }
    } else {
      // Publisher ICE candidate
      const publisher = sfuRoom.publishers.get(userId);
      if (publisher && publisher.pc) {
        publisher.pc.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
      }
    }
  });

  // Handle user disconnect
  socket.on('disconnect', () => {
    handleUserDisconnect(socket);
  });
});

// Helper function to handle subscriptions
async function handleSubscription(roomId, userId, targetId) {
  const sfuRoom = sfuConnections.get(roomId);
  if (!sfuRoom) return;

  const publisher = sfuRoom.publishers.get(targetId);
  if (!publisher || !publisher.stream) return;

  const room = rooms.get(roomId);
  if (!room) return;

  const subscriber = room.participants.get(userId);
  if (!subscriber) return;

  if (!sfuRoom.subscribers.has(userId)) {
    sfuRoom.subscribers.set(userId, new Map());
  }

  const subscriberPCs = sfuRoom.subscribers.get(userId);
  
  if (!subscriberPCs.has(targetId)) {
    const pc = createPeerConnection(userId, roomId);
    
    publisher.stream.getTracks().forEach(track => {
      pc.addTrack(track, publisher.stream);
    });

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      io.to(subscriber.socketId).emit('sfu-offer', {
        sdp: pc.localDescription,
        userId: targetId
      });
      
      subscriberPCs.set(targetId, pc);
    } catch (error) {
      console.error('Error creating subscription:', error);
    }
  }
}

// Helper function to handle user disconnect
function handleUserDisconnect(socket) {
  let disconnectedUser = null;
  let disconnectedRoom = null;

  rooms.forEach((room, roomId) => {
    room.participants.forEach((participant, userId) => {
      if (participant.socketId === socket.id) {
        disconnectedUser = userId;
        disconnectedRoom = roomId;
      }
    });
  });

  if (disconnectedUser && disconnectedRoom) {
    const room = rooms.get(disconnectedRoom);
    const sfuRoom = sfuConnections.get(disconnectedRoom);

    if (room) {
      room.participants.delete(disconnectedUser);
      if (room.participants.size === 0) {
        rooms.delete(disconnectedRoom);
      }
    }

    if (sfuRoom) {
      // Clean up publisher
      const publisher = sfuRoom.publishers.get(disconnectedUser);
      if (publisher) {
        if (publisher.pc) publisher.pc.close();
        sfuRoom.publishers.delete(disconnectedUser);
      }

      // Clean up subscriber
      const subscribers = sfuRoom.subscribers.get(disconnectedUser);
      if (subscribers) {
        subscribers.forEach(pc => pc.close());
        sfuRoom.subscribers.delete(disconnectedUser);
      }

      // Clean up other subscribers to this user
      sfuRoom.subscribers.forEach(subscriberPCs => {
        const pc = subscriberPCs.get(disconnectedUser);
        if (pc) {
          pc.close();
          subscriberPCs.delete(disconnectedUser);
        }
      });

      if (sfuRoom.publishers.size === 0 && sfuRoom.subscribers.size === 0) {
        sfuConnections.delete(disconnectedRoom);
      }
    }

    socket.to(disconnectedRoom).emit('user-left', { userId: disconnectedUser });
  }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
