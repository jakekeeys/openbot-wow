// The bridge's client for the account's other OpenBot servers (dist/team.mjs).
import "./polyfill";

export { createDirectory } from "./directory";
export { createHostClient, TeamHostClient } from "./host";
export * as shapes from "./shapes";
