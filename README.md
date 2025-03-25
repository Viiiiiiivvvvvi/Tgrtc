# TGRTC - WebRTC Live Video Streaming Service

A WebRTC service for live video streaming, inspired by Tencent Cloud's TRTC.

## Features

- Real-time audio and video communication
- Support for both anchor (broadcaster) and audience roles
- Room creation and joining functionality
- Role switching between anchor and audience
- Local and remote video/audio control
- Signaling server for WebRTC connection establishment

## Project Structure

```
Tgrtc/
├── public/              # Static files served to clients
│   ├── css/             # CSS stylesheets
│   ├── js/              # Client-side JavaScript
│   └── index.html       # Main HTML page
├── src/                 # Source code
│   └── tgrtc.js         # TGRTC library
├── server.js            # Signaling server
├── package.json         # Project dependencies
└── README.md            # Project documentation
```

## Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

## Usage

1. Start the server:

```bash
npm start
```

2. Open your browser and navigate to `http://localhost:3000`

3. Enter a user ID and optionally a room ID to join an existing room
   - If no room ID is provided, a new room will be created
   - Select your role (Anchor or Audience)

4. As an Anchor, you can:
   - Broadcast your video and audio
   - Control your video and audio streams
   - Switch to Audience role

5. As an Audience, you can:
   - View and hear Anchors' streams
   - Switch to Anchor role to start broadcasting

## API Reference

The TGRTC library provides the following main methods:

- `TGRTC.create()` - Create a new TGRTC instance
- `enterRoom(options)` - Join a room
- `exitRoom()` - Leave the current room
- `startLocalVideo(options)` - Start local video
- `stopLocalVideo()` - Stop local video
- `startLocalAudio(options)` - Start local audio
- `stopLocalAudio()` - Stop local audio
- `startRemoteVideo(options)` - Start remote video
- `stopRemoteVideo(options)` - Stop remote video
- `muteRemoteAudio(options)` - Mute/unmute remote audio
- `switchRole(options)` - Switch between anchor and audience roles

## Technologies Used

- WebRTC for peer-to-peer communication
- Socket.IO for signaling
- Express for the web server
- JavaScript for client and server logic

## Browser Compatibility

This application works on modern browsers that support WebRTC:
- Chrome (desktop and mobile)
- Firefox (desktop and mobile)
- Safari (desktop and mobile)
- Edge (Chromium-based)

## License

MIT
