// Thin wrappers over the server API. One place that knows the wire format.

async function call(method, url, body, raw) {
  const init = { method };
  if (raw) {
    init.body = raw;
    init.headers = { "content-type": "application/octet-stream" };
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* a download is not JSON */ }
  if (!res.ok) {
    // The server puts a readable sentence in `error`; surface that rather than a code.
    throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  }
  return data;
}

export const api = {
  schema: () => call("GET", "/api/schema"),
  tools: () => call("GET", "/api/tools"),

  listGraphs: () => call("GET", "/api/graphs"),
  getGraph: (id) => call("GET", `/api/graphs/${id}`),
  createGraph: (name, graph) => call("POST", "/api/graphs", { name, graph }),
  saveGraph: (id, name, graph) => call("PUT", `/api/graphs/${id}`, { name, graph }),
  deleteGraph: (id) => call("DELETE", `/api/graphs/${id}`),

  uploadMta: (name, bytes) =>
    call("POST", `/api/mta?name=${encodeURIComponent(name)}`, undefined, bytes),

  analyze: (graph) => call("POST", "/api/analyze", { graph }),
  estimate: (graph) => call("POST", "/api/estimate", { graph }),
  parseMta: (bytes) => call("POST", "/api/mta/parse", undefined, bytes),
  traces: (jobId) => call("GET", `/api/jobs/${jobId}/traces`),

  generate: (payload) => call("POST", "/api/generate", payload),
  job: (id) => call("GET", `/api/jobs/${id}`),
  downloadUrl: (id) => `/api/jobs/${id}/download`,

  file: (jobId, filePath) =>
    call("GET", `/api/jobs/${jobId}/file?path=${encodeURIComponent(filePath)}`),

  runStatus: () => call("GET", "/api/run-status"),
  run: (jobId, task) => call("POST", `/api/jobs/${jobId}/run`, { task }),
  stopRun: (runId) => call("DELETE", `/api/runs/${runId}`),
  runStreamUrl: (runId) => `/api/runs/${runId}/stream`,
};

/**
 * Poll a job until it stops moving.
 *
 * `onTick` sees every state change, so the UI can say "running" rather than freezing on
 * "queued" — a generation takes seconds and silence reads as a hang.
 */
export async function waitForJob(id, onTick, intervalMs = 400) {
  let last = "";
  for (;;) {
    const job = await api.job(id);
    if (job.state !== last) { last = job.state; onTick?.(job); }
    if (["done", "failed", "cancelled"].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
