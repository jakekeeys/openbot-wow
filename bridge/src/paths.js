// Where the bridge keeps its settings and state.
import os from 'node:os';
import path from 'node:path';

export const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'openbot-wow');
export const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'openbot-wow');
