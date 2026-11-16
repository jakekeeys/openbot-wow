// Is there a newer version on GitHub? Twice a day, one unauthenticated call to GitHub's compare
// API between the installed commit and the repository's branch: `ahead_by` is how many commits
// the branch has that this install doesn't. Nothing else is sent. A commit GitHub doesn't know
// (unpushed local work) answers 404, which reads as "no news". Off with `"updateCheck": false`.

export const UPDATE_REPO = 'jakekeeys/openbot-wow';
export const UPDATE_BRANCH = 'openbot';
const EVERY_MS = 12 * 60 * 60 * 1000;
const FIRST_MS = 60 * 1000;

export function startUpdateCheck({ build, config = {}, log = () => {}, onChange = () => {}, fetchImpl = fetch, firstMs = FIRST_MS, everyMs = EVERY_MS } = {}) {
  const repo = config.updateRepo || UPDATE_REPO;
  const branch = config.updateBranch || UPDATE_BRANCH;
  const state = { enabled: config.updateCheck !== false && !!build?.commit, available: 0, checkedAt: null, error: null, repo, branch };
  let timer = null;
  let stopped = false;

  async function check() {
    if (!state.enabled || stopped) return state;
    const before = state.available;
    try {
      const url = `https://api.github.com/repos/${repo}/compare/${build.commit}...${encodeURIComponent(branch)}`;
      const res = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'openbot-wow' }, signal: AbortSignal.timeout(15000) });
      if (res.status === 404) state.available = 0;
      else if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
      else state.available = Math.max(0, Number((await res.json())?.ahead_by) || 0);
      state.error = null;
      state.checkedAt = new Date().toISOString();
      if (state.available !== before) {
        if (state.available) log(`update available: ${state.available} new change${state.available === 1 ? '' : 's'} on ${repo} ${branch}`);
        onChange(state);
      }
    } catch (err) {
      state.error = err.message;
    }
    return state;
  }

  const loop = (delay) => {
    if (!state.enabled || stopped) return;
    timer = setTimeout(async () => {
      await check();
      loop(everyMs);
    }, delay);
    timer.unref?.();
  };
  loop(firstMs);

  return {
    status: () => ({ ...state }),
    check,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
