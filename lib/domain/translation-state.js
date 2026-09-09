const jobTransitions = Object.freeze({
  pending: new Set(['running', 'cancelled']),
  running: new Set(['completed', 'failed', 'cancelled']),
  failed: new Set(['pending']),
  cancelled: new Set(['pending']),
  completed: new Set()
});

const segmentTransitions = Object.freeze({
  pending: new Set(['translating']),
  translating: new Set(['completed', 'failed', 'cancelled']),
  failed: new Set(['pending']),
  cancelled: new Set(['pending']),
  completed: new Set()
});

function assertTransition(transitions, from, to, type) {
  if (from === to) return true;
  if (!transitions[from]?.has(to)) {
    const error = new Error(`${type}状态不允许从 ${from} 转换为 ${to}。`);
    error.code = type === '任务' ? 'INVALID_JOB_TRANSITION' : 'INVALID_SEGMENT_TRANSITION';
    error.status = 409;
    throw error;
  }
  return true;
}

export const assertJobTransition = (from, to) => assertTransition(jobTransitions, from, to, '任务');
export const assertSegmentTransition = (from, to) => assertTransition(segmentTransitions, from, to, '分段');
export const isLeaseExpired = (leaseUntil, timestamp = Date.now()) => !leaseUntil || Date.parse(leaseUntil) <= timestamp;
