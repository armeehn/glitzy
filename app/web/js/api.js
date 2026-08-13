/* Talking to the engine.
 *
 * Everything slow is a job: POST returns an id, then we poll. That is what
 * lets the studio show progress and offer a cancel instead of holding a socket
 * open for forty seconds and hoping nothing times out in between.
 */

async function parse(r) {
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!r.ok) {
    const err = new Error((body && body.error) || text || ('HTTP ' + r.status));
    err.status = r.status;
    if (body && body.node !== undefined) err.node = body.node;
    throw err;
  }
  return body;
}

export const jget = (u) => fetch(u).then(parse);

export const jpost = (u, body) =>
  fetch(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(parse);

export const jdel = (u) => fetch(u, { method: 'DELETE' }).then(parse);

export const upload = (file) =>
  fetch('/api/source?name=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  }).then(parse);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a job to completion.
 *
 * The poll interval starts tight and backs off: a cached chain finishes in
 * well under a second and should feel instant, while a four-pass codec stack
 * does not need to be asked twenty times a second how it is doing.
 */
export async function pollJob(id, onProgress, shouldStop) {
  let delay = 90;
  for (;;) {
    const job = await jget('/api/job/' + id);
    if (onProgress) onProgress(job);
    if (job.state === 'done') return job;
    if (job.state === 'error') {
      const err = new Error(job.error || 'The engine gave up.');
      if (job.result && job.result.node !== undefined) err.node = job.result.node;
      throw err;
    }
    if (job.state === 'cancelled') {
      const err = new Error('Cancelled.');
      err.cancelled = true;
      throw err;
    }
    if (shouldStop && shouldStop()) {
      cancelJob(id);
      const err = new Error('Superseded.');
      err.cancelled = true;
      throw err;
    }
    await wait(delay);
    delay = Math.min(600, Math.round(delay * 1.25));
  }
}

export const cancelJob = (id) =>
  fetch('/api/job/' + id + '/cancel', { method: 'POST' }).catch(() => {});

export const frameUrl = (hash, n) => `/api/node/${hash}/frame/${n}`;
export const thumbUrl = (hash, n = 0) => `/api/node/${hash}/thumb/${n}`;
