// OpenBot's client uses the browser's WebRTC classes. node-datachannel provides the same API on Node.
import { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from "node-datachannel/polyfill";

Object.assign(globalThis, { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate });
