export async function withBudget(promise, milliseconds, label = 'test operation') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })
    ]);
  } finally { clearTimeout(timer); }
}

async function settledWithin(promise, milliseconds) {
  const timeout = Symbol('timeout');
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(timeout), milliseconds); })]) !== timeout;
  } finally { clearTimeout(timer); }
}

// Bind close before any await: a child may have already exited when cleanup runs.
export function superviseChild(child, { label = 'test child', graceMs = 1000, killMs = 1000 } = {}) {
  let record, spawnError, output = '', stopping;
  const observers = new Set();
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    record = { code, signal }; resolve(record);
    for (const observe of observers) observe();
  }));
  child.on('error', error => { spawnError = error; for (const observe of observers) observe(); });
  child.stdin?.on('error', () => {}); // A child exiting during graceful shutdown can cause EPIPE.
  child.stdout?.on('data', data => {
    output = (output + data.toString()).slice(-8192);
    for (const observe of observers) observe();
  });
  // Always drain stderr, including failed setup, so a full pipe cannot block exit.
  child.stderr?.resume();

  async function ready(marker = 'READY', timeoutMs = 5000) {
    let observe;
    try {
      await withBudget(new Promise((resolve, reject) => {
        observe = () => {
          if (spawnError) reject(new Error(`${label} could not start (${spawnError.code || 'spawn error'})`));
          else if (output.includes(marker)) resolve();
          else if (record) reject(new Error(`${label} exited before ready (${record.code ?? record.signal})`));
        };
        observers.add(observe); observe();
      }), timeoutMs, `${label} startup`);
    } finally { observers.delete(observe); }
  }

  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      let forced = false;
      try {
        if (!record) {
          if (child.stdin?.writable && !child.stdin.destroyed) child.stdin.end('\n');
          if (!await settledWithin(closed, graceMs)) {
            forced = true;
            child.kill('SIGTERM');
            if (!await settledWithin(closed, killMs)) {
              child.kill('SIGKILL');
              for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
              if (!await settledWithin(closed, killMs)) {
                child.unref();
                throw new Error(`${label} did not exit after forced cleanup`);
              }
            }
          }
        }
        return { ...record, forced };
      } finally {
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      }
    })();
    return stopping;
  }
  return { closed, ready, stop };
}

export async function closeHttpServer(server, close = () => new Promise(resolve => server.close(resolve)), milliseconds = 2000) {
  const closing = close();
  // Tests are finished: close both idle keep-alive sockets and active failures.
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await withBudget(closing, milliseconds, 'HTTP fixture cleanup');
}
