/**
 * TGRTC - A WebRTC service for live video streaming
 * Inspired by Tencent Cloud's TRTC
 */

class TGRTC {
  /**
   * Create a TGRTC instance
   * @returns {TGRTC} TGRTC instance
   */
  static create() {
    return new TGRTC();
  }

  constructor() {
    this.socket = null;
    this.localStream = null;
    this.remoteStreams = new Map(); // userId -> stream
    this.sfuConnection = null; // Single connection to SFU for publishing
    this.sfuSubscriptions = new Map(); // userId -> RTCPeerConnection for subscribing
    this.roomId = null;
    this.userId = null;
    this.isAnchor = false;
    this.eventHandlers = new Map();
    // Default RTC configuration with extensive STUN/TURN servers
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.stunprotocol.org:3478' },
        { urls: 'stun:stun.sipnet.net:3478' },
        { urls: 'stun:stun.ideasip.com:3478' },
        { urls: 'stun:stun.iptel.org:3478' },
        {
          urls: 'turn:numb.viagenie.ca',
          username: 'webrtc@live.com',
          credential: 'muazkh'
        },
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
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:relay.metered.ca:80',
          username: 'c9e9f2f0a6f2f0e9a8f0',
          credential: 'Xr7/iQkXDMGCwVZm'
        },
        {
          urls: 'turn:relay.metered.ca:443',
          username: 'c9e9f2f0a6f2f0e9a8f0',
          credential: 'Xr7/iQkXDMGCwVZm'
        },
        {
          urls: 'turn:relay.metered.ca:443?transport=tcp',
          username: 'c9e9f2f0a6f2f0e9a8f0',
          credential: 'Xr7/iQkXDMGCwVZm'
        }
      ],
      iceCandidatePoolSize: 10,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      sdpSemantics: 'unified-plan'
    };
  }

  /**
   * Add event listener
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
    return this;
  }

  /**
   * Remove event listener
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  off(event, handler) {
    if (!this.eventHandlers.has(event)) return this;
    
    if (handler) {
      const handlers = this.eventHandlers.get(event);
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    } else {
      this.eventHandlers.delete(event);
    }
    
    return this;
  }

  /**
   * Trigger event
   * @param {string} event - Event name
   * @param {Object} data - Event data
   * @private
   */
  _triggerEvent(event, data) {
    if (!this.eventHandlers.has(event)) return;
    
    for (const handler of this.eventHandlers.get(event)) {
      handler(data);
    }
  }

  /**
   * Connect to signaling server
   * @param {string} serverUrl - Signaling server URL
   * @private
   */
  _connectSignalingServer(serverUrl = window.location.origin) {
    return new Promise((resolve, reject) => {
      try {
        this.socket = io(serverUrl);
        
        this.socket.on('connect', () => {
          console.log('Connected to signaling server');
          resolve();
        });
        
        this.socket.on('connect_error', (error) => {
          console.error('Connection error:', error);
          reject(error);
        });
        
        // Handle signaling messages
        this.socket.on('room-created', (data) => {
          this._handleRoomCreated(data);
        });
        
        this.socket.on('room-joined', (data) => {
          this._handleRoomJoined(data);
        });
        
        this.socket.on('user-joined', (data) => {
          this._handleUserJoined(data);
        });
        
        this.socket.on('user-left', (data) => {
          this._handleUserLeft(data);
        });
        
        // SFU specific events
        this.socket.on('sfu-offer', (data) => {
          this._handleSfuOffer(data);
        });
        
        this.socket.on('sfu-answer', (data) => {
          this._handleSfuAnswer(data);
        });
        
        this.socket.on('sfu-ice-candidate', (data) => {
          this._handleSfuIceCandidate(data);
        });
        
        this.socket.on('role-switched', (data) => {
          this._handleRoleSwitched(data);
        });
        
        this.socket.on('restart-connection', (data) => {
          this._handleRestartConnection(data);
        });
        
        this.socket.on('error', (data) => {
          console.error('Server error:', data.message);
          this._triggerEvent('error', { code: 'SERVER_ERROR', message: data.message });
        });
      } catch (error) {
        console.error('Failed to connect to signaling server:', error);
        reject(error);
      }
    });
  }

  /**
   * Handle room created event
   * @param {Object} data - Room data
   * @private
   */
  _handleRoomCreated(data) {
    this.roomId = data.roomId;
    this.userId = data.userId;
    this.isAnchor = data.isAnchor;
    
    console.log(`Room created: ${this.roomId}`);
    this._triggerEvent('room-created', data);
    
    // If there are other participants, create peer connections
    if (data.participants && data.participants.length > 1) {
      for (const participant of data.participants) {
        if (participant.id !== this.userId) {
          this._createPeerConnection(participant.id);
          
          // If we are anchor, send offer to audience
          if (this.isAnchor && !participant.isAnchor && this.localStream) {
            this._createAndSendOffer(participant.id);
          }
        }
      }
    }
  }

  /**
   * Handle room joined event
   * @param {Object} data - Room data
   * @private
   */
  _handleRoomJoined(data) {
    this.roomId = data.roomId;
    this.userId = data.userId;
    this.isAnchor = data.isAnchor;
    
    console.log(`Room joined: ${this.roomId}`);
    this._triggerEvent('room-joined', data);
    
    // Create peer connections with existing participants
    if (data.participants && data.participants.length > 1) {
      for (const participant of data.participants) {
        if (participant.id !== this.userId) {
          this._createPeerConnection(participant.id);
          
          // If we are audience and other is anchor, wait for their offer
          // If we are anchor, send offer to everyone
          if (this.isAnchor && this.localStream) {
            this._createAndSendOffer(participant.id);
          }
        }
      }
    }
  }

  /**
   * Handle user joined event
   * @param {Object} data - User data
   * @private
   */
  _handleUserJoined(data) {
    console.log(`User joined: ${data.userId}`);
    this._triggerEvent('user-joined', data);
    
    // Create peer connection with new user
    this._createPeerConnection(data.userId);
    
    // If we are anchor and have local stream, send offer to new user
    if (this.isAnchor && this.localStream) {
      this._createAndSendOffer(data.userId);
    }
  }

  /**
   * Handle user left event
   * @param {Object} data - User data
   * @private
   */
  _handleUserLeft(data) {
    console.log(`User left: ${data.userId}`);
    this._triggerEvent('user-left', data);
    
    // Clean up peer connection and remote stream
    this._cleanupPeerConnection(data.userId);
  }

  /**
   * Handle offer event
   * @param {Object} data - Offer data
   * @private
   */
  async _handleOffer(data) {
    console.log(`Received offer from ${data.userId}`);
    
    const pc = this._getPeerConnection(data.userId);
    
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      
      // Create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      // Send answer to peer
      this.socket.emit('answer', {
        roomId: this.roomId,
        userId: this.userId,
        targetId: data.userId,
        sdp: pc.localDescription
      });
    } catch (error) {
      console.error('Error handling offer:', error);
      this._triggerEvent('error', { code: 'RTC_ERROR', message: error.message });
    }
  }

  /**
   * Handle answer event
   * @param {Object} data - Answer data
   * @private
   */
  async _handleAnswer(data) {
    console.log(`Received answer from ${data.userId}`);
    
    const pc = this._getPeerConnection(data.userId);
    
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } catch (error) {
      console.error('Error handling answer:', error);
      this._triggerEvent('error', { code: 'RTC_ERROR', message: error.message });
    }
  }

  /**
   * Handle ICE candidate event
   * @param {Object} data - ICE candidate data
   * @private
   */
  async _handleIceCandidate(data) {
    console.log(`Received ICE candidate from ${data.userId}`);
    
    const pc = this._getPeerConnection(data.userId);
    
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (error) {
      console.error('Error handling ICE candidate:', error);
      // Non-critical error, don't trigger event
    }
  }

  /**
   * Handle role switched event
   * @param {Object} data - Role data
   * @private
   */
  _handleRoleSwitched(data) {
    console.log(`User ${data.userId} switched role to ${data.isAnchor ? 'anchor' : 'audience'}`);
    this._triggerEvent('role-switched', data);
    
    // If it's our role that changed
    if (data.userId === this.userId) {
      this.isAnchor = data.isAnchor;
      
      // If we became anchor and have local stream, send offers
      if (this.isAnchor && this.localStream) {
        for (const [userId, pc] of this.peerConnections.entries()) {
          this._createAndSendOffer(userId);
        }
      }
    }
  }
  
  /**
   * Handle restart connection request
   * @param {Object} data - Restart data
   * @private
   */
  _handleRestartConnection(data) {
    console.log(`Received restart connection request from ${data.userId}`);
    
    // If we are the anchor, create and send a new offer with ICE restart
    if (this.isAnchor) {
      console.log(`Creating new offer with ICE restart for ${data.targetId}`);
      this._createAndSendOffer(data.targetId, { iceRestart: true });
    }
  }

  /**
   * Create peer connection
   * @param {string} userId - User ID
   * @returns {RTCPeerConnection} Peer connection
   * @private
   */
  _createPeerConnection(userId) {
    if (this.peerConnections.has(userId)) {
      return this.peerConnections.get(userId);
    }
    
    console.log('Creating peer connection with ICE config:', JSON.stringify(this.rtcConfig));
    const pc = new RTCPeerConnection(this.rtcConfig);
    
    // Add local stream tracks to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }
    
    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('ice-candidate', {
          roomId: this.roomId,
          userId: this.userId,
          targetId: userId,
          candidate: event.candidate
        });
      }
    };
    
    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      console.log(`Connection state with ${userId}: ${pc.connectionState}`);
      
      if (pc.connectionState === 'failed') {
        console.log(`Connection with ${userId} failed. Attempting to restart ICE...`);
        
        // Try to restart ICE
        setTimeout(() => {
          console.log(`Restarting ICE for ${userId}...`);
          
          // Both peers should try to restart the connection
          if (this.isAnchor) {
            this._createAndSendOffer(userId, { iceRestart: true });
          } else {
            // For non-anchors, send a restart request to the anchor
            this.socket.emit('restart-request', {
              roomId: this.roomId,
              userId: this.userId,
              targetId: userId
            });
          }
        }, 1000);
      } else if (pc.connectionState === 'connected') {
        console.log(`Successfully connected to ${userId}`);
      } else if (pc.connectionState === 'disconnected') {
        console.log(`Connection with ${userId} disconnected. Waiting for reconnection...`);
      }
    };
    
    // Handle ICE connection state changes
    pc.oniceconnectionstatechange = () => {
      console.log(`ICE connection state with ${userId}: ${pc.iceConnectionState}`);
    };
    
    // Log ICE gathering state changes
    pc.onicegatheringstatechange = () => {
      console.log(`ICE gathering state with ${userId}: ${pc.iceGatheringState}`);
    };
    
    // Handle remote tracks
    pc.ontrack = (event) => {
      console.log(`Received remote track from ${userId}`);
      
      if (!this.remoteStreams.has(userId)) {
        this.remoteStreams.set(userId, new MediaStream());
        this._triggerEvent('remote-stream-available', { userId });
      }
      
      const remoteStream = this.remoteStreams.get(userId);
      event.streams[0].getTracks().forEach(track => {
        remoteStream.addTrack(track);
      });
      
      if (event.track.kind === 'video') {
        this._triggerEvent('remote-video-available', { userId });
      } else if (event.track.kind === 'audio') {
        this._triggerEvent('remote-audio-available', { userId });
      }
    };
    
    this.peerConnections.set(userId, pc);
    return pc;
  }

  /**
   * Get peer connection
   * @param {string} userId - User ID
   * @returns {RTCPeerConnection} Peer connection
   * @private
   */
  _getPeerConnection(userId) {
    if (!this.peerConnections.has(userId)) {
      return this._createPeerConnection(userId);
    }
    return this.peerConnections.get(userId);
  }

  /**
   * Create and send offer
   * @param {string} userId - User ID
   * @private
   */
  async _createAndSendOffer(userId, options = {}) {
    const pc = this._getPeerConnection(userId);
    
    try {
      const offerOptions = {};
      
      // Add iceRestart option if specified
      if (options.iceRestart) {
        offerOptions.iceRestart = true;
      }
      
      const offer = await pc.createOffer(offerOptions);
      await pc.setLocalDescription(offer);
      
      this.socket.emit('offer', {
        roomId: this.roomId,
        userId: this.userId,
        targetId: userId,
        sdp: pc.localDescription
      });
    } catch (error) {
      console.error('Error creating offer:', error);
      this._triggerEvent('error', { code: 'RTC_ERROR', message: error.message });
    }
  }

  /**
   * Clean up peer connection
   * @param {string} userId - User ID
   * @private
   */
  _cleanupPeerConnection(userId) {
    // Close and remove peer connection
    if (this.peerConnections.has(userId)) {
      const pc = this.peerConnections.get(userId);
      pc.close();
      this.peerConnections.delete(userId);
    }
    
    // Remove remote stream
    if (this.remoteStreams.has(userId)) {
      this.remoteStreams.delete(userId);
      this._triggerEvent('remote-stream-unavailable', { userId });
    }
  }

  /**
   * Enter a room
   * @param {Object} options - Room options
   * @param {string} options.roomId - Room ID (optional, will be generated if not provided)
   * @param {string} options.userId - User ID
   * @param {boolean} options.isAnchor - Whether the user is an anchor (default: false)
   * @returns {Promise<void>}
   */
  async enterRoom(options) {
    if (!options.userId) {
      throw new Error('userId is required');
    }
    
    try {
      // Connect to signaling server if not connected
      if (!this.socket || !this.socket.connected) {
        await this._connectSignalingServer();
      }
      
      // Create or join room
      if (options.roomId) {
        this.socket.emit('join-room', {
          roomId: options.roomId,
          userId: options.userId,
          isAnchor: options.isAnchor || false
        });
      } else {
        this.socket.emit('create-room', {
          userId: options.userId,
          isAnchor: options.isAnchor !== false // Default to true for room creator
        });
      }
      
      // Return a promise that resolves when room is created/joined
      return new Promise((resolve) => {
        const onRoomCreated = (data) => {
          this.off('room-created', onRoomCreated);
          resolve(data);
        };
        
        const onRoomJoined = (data) => {
          this.off('room-joined', onRoomJoined);
          resolve(data);
        };
        
        this.on('room-created', onRoomCreated);
        this.on('room-joined', onRoomJoined);
      });
    } catch (error) {
      console.error('Error entering room:', error);
      throw error;
    }
  }

  /**
   * Exit the current room
   * @returns {Promise<void>}
   */
  async exitRoom() {
    if (!this.roomId || !this.userId) {
      console.warn('Not in a room');
      return;
    }
    
    // Notify server
    this.socket.emit('leave-room', {
      roomId: this.roomId,
      userId: this.userId
    });
    
    // Clean up peer connections
    for (const userId of this.peerConnections.keys()) {
      this._cleanupPeerConnection(userId);
    }
    
    // Reset room state
    this.roomId = null;
    this.userId = null;
    this.isAnchor = false;
    
    // Stop local stream if exists
    this.stopLocalVideo();
    this.stopLocalAudio();
    
    return Promise.resolve();
  }

  /**
   * Start local video
   * @param {Object} options - Video options
   * @param {HTMLElement} options.element - Video element to display local video
   * @param {MediaStreamConstraints} options.constraints - Media constraints
   * @returns {Promise<void>}
   */
  async startLocalVideo(options = {}) {
    try {
      // Check if mediaDevices is supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('WebRTC is not supported in this browser. Please use Chrome, Firefox, or Safari.');
      }

      // Create local stream if not exists
      if (!this.localStream) {
        this.localStream = new MediaStream();
      }
      
      // Get video stream
      const constraints = options.constraints || { video: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Add video track to local stream
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        // Remove existing video tracks
        this.localStream.getVideoTracks().forEach(track => {
          this.localStream.removeTrack(track);
          track.stop();
        });
        
        // Add new video track
        this.localStream.addTrack(videoTrack);
        
        // Add track to all peer connections
        for (const pc of this.peerConnections.values()) {
          const senders = pc.getSenders();
          const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
          
          if (videoSender) {
            videoSender.replaceTrack(videoTrack);
          } else {
            pc.addTrack(videoTrack, this.localStream);
          }
        }
        
        // If we are anchor, create and send offers to all peers
        if (this.isAnchor) {
          for (const userId of this.peerConnections.keys()) {
            this._createAndSendOffer(userId);
          }
        }
        
        // Display local video if element provided
        if (options.element) {
          options.element.srcObject = this.localStream;
          options.element.autoplay = true;
          options.element.playsInline = true;
          options.element.muted = true; // Mute local video to prevent feedback
        }
        
        this._triggerEvent('local-video-available', { track: videoTrack });
      }
      
      return Promise.resolve();
    } catch (error) {
      console.error('Error starting local video:', error);
      this._triggerEvent('error', { code: 'MEDIA_ERROR', message: error.message });
      return Promise.reject(error);
    }
  }

  /**
   * Stop local video
   * @returns {Promise<void>}
   */
  async stopLocalVideo() {
    if (!this.localStream) {
      return Promise.resolve();
    }
    
    // Stop video tracks
    this.localStream.getVideoTracks().forEach(track => {
      track.stop();
      this.localStream.removeTrack(track);
    });
    
    // Remove video track from all peer connections
    for (const pc of this.peerConnections.values()) {
      const senders = pc.getSenders();
      const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
      
      if (videoSender) {
        pc.removeTrack(videoSender);
      }
    }
    
    this._triggerEvent('local-video-unavailable', {});
    
    // If we are anchor, create and send offers to all peers to update
    if (this.isAnchor) {
      for (const userId of this.peerConnections.keys()) {
        this._createAndSendOffer(userId);
      }
    }
    
    return Promise.resolve();
  }

  /**
   * Start local audio
   * @param {Object} options - Audio options
   * @param {MediaStreamConstraints} options.constraints - Media constraints
   * @returns {Promise<void>}
   */
  async startLocalAudio(options = {}) {
    try {
      // Check if mediaDevices is supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('WebRTC is not supported in this browser. Please use Chrome, Firefox, or Safari.');
      }

      // Create local stream if not exists
      if (!this.localStream) {
        this.localStream = new MediaStream();
      }
      
      // Get audio stream
      const constraints = options.constraints || { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Add audio track to local stream
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        // Remove existing audio tracks
        this.localStream.getAudioTracks().forEach(track => {
          this.localStream.removeTrack(track);
          track.stop();
        });
        
        // Add new audio track
        this.localStream.addTrack(audioTrack);
        
        // Add track to all peer connections
        for (const pc of this.peerConnections.values()) {
          const senders = pc.getSenders();
          const audioSender = senders.find(sender => sender.track && sender.track.kind === 'audio');
          
          if (audioSender) {
            audioSender.replaceTrack(audioTrack);
          } else {
            pc.addTrack(audioTrack, this.localStream);
          }
        }
        
        // If we are anchor, create and send offers to all peers
        if (this.isAnchor) {
          for (const userId of this.peerConnections.keys()) {
            this._createAndSendOffer(userId);
          }
        }
        
        this._triggerEvent('local-audio-available', { track: audioTrack });
      }
      
      return Promise.resolve();
    } catch (error) {
      console.error('Error starting local audio:', error);
      this._triggerEvent('error', { code: 'MEDIA_ERROR', message: error.message });
      return Promise.reject(error);
    }
  }

  /**
   * Stop local audio
   * @returns {Promise<void>}
   */
  async stopLocalAudio() {
    if (!this.localStream) {
      return Promise.resolve();
    }
    
    // Stop audio tracks
    this.localStream.getAudioTracks().forEach(track => {
      track.stop();
      this.localStream.removeTrack(track);
    });
    
    // Remove audio track from all peer connections
    for (const pc of this.peerConnections.values()) {
      const senders = pc.getSenders();
      const audioSender = senders.find(sender => sender.track && sender.track.kind === 'audio');
      
      if (audioSender) {
        pc.removeTrack(audioSender);
      }
    }
    
    this._triggerEvent('local-audio-unavailable', {});
    
    // If we are anchor, create and send offers to all peers to update
    if (this.isAnchor) {
      for (const userId of this.peerConnections.keys()) {
        this._createAndSendOffer(userId);
      }
    }
    
    return Promise.resolve();
  }

  /**
   * Start remote video
   * @param {Object} options - Video options
   * @param {string} options.userId - User ID
   * @param {HTMLElement} options.element - Video element to display remote video
   * @returns {Promise<void>}
   */
  async startRemoteVideo(options) {
    if (!options.userId) {
      throw new Error('userId is required');
    }
    
    if (!options.element) {
      throw new Error('element is required');
    }
    
    if (!this.remoteStreams.has(options.userId)) {
      console.warn(`No remote stream available for user ${options.userId}`);
      
      // Wait for remote stream to become available
      return new Promise((resolve) => {
        const onRemoteStreamAvailable = (data) => {
          if (data.userId === options.userId) {
            this.off('remote-stream-available', onRemoteStreamAvailable);
            this.startRemoteVideo(options).then(resolve);
          }
        };
        
        this.on('remote-stream-available', onRemoteStreamAvailable);
      });
    }
    
    // Display remote stream
    options.element.srcObject = this.remoteStreams.get(options.userId);
    options.element.autoplay = true;
    options.element.playsInline = true;
    
    return Promise.resolve();
  }

  /**
   * Stop remote video
   * @param {Object} options - Video options
   * @param {string} options.userId - User ID
   * @returns {Promise<void>}
   */
  async stopRemoteVideo(options) {
    if (!options.userId) {
      throw new Error('userId is required');
    }
    
    if (!this.remoteStreams.has(options.userId)) {
      console.warn(`No remote stream available for user ${options.userId}`);
      return Promise.resolve();
    }
    
    // We don't actually stop the remote stream, just detach it from any elements
    return Promise.resolve();
  }

  /**
   * Mute remote audio
   * @param {Object} options - Audio options
   * @param {string} options.userId - User ID
   * @param {boolean} options.mute - Whether to mute (true) or unmute (false)
   * @returns {Promise<void>}
   */
  async muteRemoteAudio(options) {
    if (!options.userId) {
      throw new Error('userId is required');
    }
    
    if (!this.remoteStreams.has(options.userId)) {
      console.warn(`No remote stream available for user ${options.userId}`);
      return Promise.resolve();
    }
    
    // Mute/unmute audio tracks
    const remoteStream = this.remoteStreams.get(options.userId);
    remoteStream.getAudioTracks().forEach(track => {
      track.enabled = !options.mute;
    });
    
    return Promise.resolve();
  }

  /**
   * Switch role between anchor and audience
   * @param {Object} options - Role options
   * @param {boolean} options.isAnchor - Whether to switch to anchor role
   * @returns {Promise<void>}
   */
  async switchRole(options) {
    if (!this.roomId || !this.userId) {
      throw new Error('Not in a room');
    }
    
    if (options.isAnchor === this.isAnchor) {
      console.warn(`Already in ${options.isAnchor ? 'anchor' : 'audience'} role`);
      return Promise.resolve();
    }
    
    // Notify server
    this.socket.emit('switch-role', {
      roomId: this.roomId,
      userId: this.userId,
      isAnchor: options.isAnchor
    });
    
    // Return a promise that resolves when role is switched
    return new Promise((resolve) => {
      const onRoleSwitched = (data) => {
        if (data.userId === this.userId) {
          this.off('role-switched', onRoleSwitched);
          resolve(data);
        }
      };
      
      this.on('role-switched', onRoleSwitched);
    });
  }
}

// Export constants
TGRTC.TYPE = {
  SCENE_RTC: 'rtc',
  SCENE_LIVE: 'live',
  ROLE_ANCHOR: 'anchor',
  ROLE_AUDIENCE: 'audience'
};

// Export events
TGRTC.EVENT = {
  ERROR: 'error',
  ROOM_CREATED: 'room-created',
  ROOM_JOINED: 'room-joined',
  USER_JOINED: 'user-joined',
  USER_LEFT: 'user-left',
  ROLE_SWITCHED: 'role-switched',
  LOCAL_VIDEO_AVAILABLE: 'local-video-available',
  LOCAL_VIDEO_UNAVAILABLE: 'local-video-unavailable',
  LOCAL_AUDIO_AVAILABLE: 'local-audio-available',
  LOCAL_AUDIO_UNAVAILABLE: 'local-audio-unavailable',
  REMOTE_VIDEO_AVAILABLE: 'remote-video-available',
  REMOTE_VIDEO_UNAVAILABLE: 'remote-video-unavailable',
  REMOTE_AUDIO_AVAILABLE: 'remote-audio-available',
  REMOTE_AUDIO_UNAVAILABLE: 'remote-audio-unavailable',
  REMOTE_STREAM_AVAILABLE: 'remote-stream-available',
  REMOTE_STREAM_UNAVAILABLE: 'remote-stream-unavailable'
};

// Export error codes
TGRTC.ERROR = {
  INVALID_PARAMETER: 'INVALID_PARAMETER',
  OPERATION_FAILED: 'OPERATION_FAILED',
  OPERATION_ABORT: 'OPERATION_ABORT',
  ENV_NOT_SUPPORTED: 'ENV_NOT_SUPPORTED',
  SERVER_ERROR: 'SERVER_ERROR',
  RTC_ERROR: 'RTC_ERROR',
  MEDIA_ERROR: 'MEDIA_ERROR'
};

// Export to global scope if in browser
if (typeof window !== 'undefined') {
  window.TGRTC = TGRTC;
}

// Export as module if in Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TGRTC;
}
