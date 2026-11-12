// OpenBot's client uses the browser's WebRTC classes. node-datachannel provides the same API on Node.
import { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from "node-datachannel/polyfill";

Object.assign(globalThis, { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate });

// libdatachannel can't restart ICE. OpenBot's peer tries it when a path stalls; this says why it
// fails, and the bridge then reconnects with a new connection.
(RTCPeerConnection.prototype as unknown as { restartIce: () => void }).restartIce = () => {
  throw new DOMException("The connection's network path changed. Reconnecting.");
};
