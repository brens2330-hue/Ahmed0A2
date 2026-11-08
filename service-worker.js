importScripts("core/background.js");

const REGION_ACCESS_URL = "https://county-back-end-blocked.vercel.app/api/access";

const ANNOUNCEMENT_BASE_URL = "https://idleryu-announcement-v3.vercel.app";

async function fetchAnnouncementData() {
  const controller = new AbortController;
  const timeoutId = setTimeout(() => controller.abort(), 6e3);
  try {
    const [annRes, verRes] = await Promise.all([ fetch(`${ANNOUNCEMENT_BASE_URL}/announcement.json`, {
      cache: "no-store",
      signal: controller.signal
    }), fetch(`${ANNOUNCEMENT_BASE_URL}/version.json`, {
      cache: "no-store",
      signal: controller.signal
    }) ]);
    const announcement = annRes.ok ? await annRes.json().catch(() => null) : null;
    const version = verRes.ok ? await verRes.json().catch(() => null) : null;
    return {
      ok: true,
      announcement: announcement,
      version: version
    };
  } catch (_) {
    return {
      ok: false
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function checkRegionAccess(tz) {
  const controller = new AbortController;
  const timeoutId = setTimeout(() => controller.abort(), 6e3);
  try {
    const url = `${REGION_ACCESS_URL}?tz=${encodeURIComponent(tz || "")}`;
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });
    if (!res.ok) return {
      ok: false
    };
    const data = await res.json();
    return {
      ok: true,
      data: data
    };
  } catch (_) {
    return {
      ok: false
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "RYU_CHECK_REGION_ACCESS") {
    checkRegionAccess(message.tz).then(sendResponse);
    return true;
  }
  if (message && message.type === "RYU_FETCH_ANNOUNCEMENT") {
    fetchAnnouncementData().then(sendResponse);
    return true;
  }
});

const WARM_ALARM_NAME = "ryuEndpointWarmup";

const WARM_INTERVAL_MINUTES = 4;

const WARM_TIMEOUT_MS = 5e3;

const WARM_URLS = [ "https://county-back-end-blocked.vercel.app/api/access", "https://idleryu-announcement-v3.vercel.app/announcement.json", "https://idleryu-announcement-v3.vercel.app/version.json", "https://1dleryu-id-gate-backend.vercel.app/api/check-user" ];

async function warmEndpoint(url) {
  const controller = new AbortController;
  const timeoutId = setTimeout(() => controller.abort(), WARM_TIMEOUT_MS);
  try {
    await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });
  } catch (_) {} finally {
    clearTimeout(timeoutId);
  }
}

function warmAllEndpoints() {
  WARM_URLS.forEach(url => {
    warmEndpoint(url);
  });
}

chrome.alarms.create(WARM_ALARM_NAME, {
  periodInMinutes: WARM_INTERVAL_MINUTES
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === WARM_ALARM_NAME) warmAllEndpoints();
});

chrome.runtime.onInstalled.addListener(() => warmAllEndpoints());

chrome.runtime.onStartup?.addListener(() => warmAllEndpoints());

// =============================================================================
// TikQuick third-party processing (API key stays in the service worker only)
// =============================================================================
const TQ_API_KEY = "1dleryu-f6a52287.1539989125975769148";
const TQ_PASSPORT = "https://tikquick.online";
const TQ_PS_BASES = [
  "https://ps.tikquick.online",
  "https://tqps.mikeden.site"
];
const TQ_CHUNK_BYTES = 20 * 1024 * 1024;
const TQ_CHUNK_CONCURRENCY = 3;
const TQ_CHUNK_MAX_RETRIES = 5;
const TQ_CHUNK_RETRY_BASE_MS = 600;

function tqSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tqFetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || text || ("HTTP " + res.status);
    throw new Error(msg + " @ " + url.split("?")[0]);
  }
  return data;
}

async function tqGenOtu() {
  const url = TQ_PASSPORT + "/passport/api/thirdparty/genotu?key=" + encodeURIComponent(TQ_API_KEY);
  const data = await tqFetchJson(url, { method: "GET" });
  if (!data || !data.token || !data.user_id) throw new Error("genotu: missing token/user_id");
  return { token: data.token, userId: data.user_id };
}

async function tqInitJob(psBase, auth, filename, totalSize, totalChunks) {
  const url =
    psBase +
    "/api/upload/init?auth_userid=" +
    encodeURIComponent(auth.userId) +
    "&auth_token=" +
    encodeURIComponent(auth.token);
  const data = await tqFetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: filename || "video.mp4",
      total_size: totalSize,
      total_chunks: totalChunks
    })
  });
  if (!data || !data.job_id || !data.job_otu) throw new Error("init: missing job_id/job_otu");
  return { jobId: data.job_id, jobOtu: data.job_otu };
}

async function tqUploadChunk(psBase, job, chunkIndex, bytes) {
  const url =
    psBase +
    "/api/upload/chunk?job_id=" +
    encodeURIComponent(job.jobId) +
    "&job_otu=" +
    encodeURIComponent(job.jobOtu) +
    "&chunk_index=" +
    encodeURIComponent(String(chunkIndex));
  let lastErr = null;
  for (let attempt = 1; attempt <= TQ_CHUNK_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", body: bytes });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error((text || ("HTTP " + res.status)) + " (chunk " + chunkIndex + ")");
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt >= TQ_CHUNK_MAX_RETRIES) break;
      await tqSleep(TQ_CHUNK_RETRY_BASE_MS * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr || new Error("chunk " + chunkIndex + " failed");
}

async function tqRunPool(count, concurrency, worker) {
  let next = 0;
  async function run() {
    while (next < count) {
      const i = next++;
      await worker(i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, count));
  const runners = [];
  for (let i = 0; i < n; i++) runners.push(run());
  await Promise.all(runners);
}

async function tqComplete(psBase, job) {
  const url =
    psBase +
    "/api/upload/complete?job_id=" +
    encodeURIComponent(job.jobId) +
    "&job_otu=" +
    encodeURIComponent(job.jobOtu);
  const res = await fetch(url, { method: "POST" });
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.error || j.message || text;
    } catch (_) {}
    throw new Error((detail || ("HTTP " + res.status)) + " (complete)");
  }
  // Some error paths return 200 + JSON error — guard that
  if (ct.includes("application/json")) {
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.error || j.message || text;
    } catch (_) {}
    throw new Error((detail || "JSON response instead of video") + " (complete)");
  }
  const buf = await res.arrayBuffer();
  if (!buf || !buf.byteLength) throw new Error("complete: empty body");
  return buf;
}

async function tqProcessOnBase(psBase, u8, filename, onProgress) {
  const totalSize = u8.byteLength;
  const totalChunks = Math.max(1, Math.ceil(totalSize / TQ_CHUNK_BYTES));

  onProgress && onProgress({ phase: "auth", percent: 2 });
  const auth = await tqGenOtu();

  onProgress && onProgress({ phase: "init", percent: 5 });
  const job = await tqInitJob(psBase, auth, filename, totalSize, totalChunks);

  let doneBytes = 0;
  await tqRunPool(totalChunks, TQ_CHUNK_CONCURRENCY, async (chunkIndex) => {
    const start = chunkIndex * TQ_CHUNK_BYTES;
    const end = Math.min(start + TQ_CHUNK_BYTES, totalSize);
    const slice = u8.subarray(start, end);
    // Dedicated buffer copy for fetch body
    const body = slice.slice().buffer;
    await tqUploadChunk(psBase, job, chunkIndex, body);
    doneBytes += end - start;
    onProgress &&
      onProgress({
        phase: "upload",
        percent: 5 + Math.min(50, (doneBytes / totalSize) * 50)
      });
  });

  onProgress && onProgress({ phase: "processing", percent: 60 });
  const out = await tqComplete(psBase, job);
  onProgress && onProgress({ phase: "download", percent: 100 });
  return out;
}

async function tqProcessVideo(arrayBuffer, filename, onProgress) {
  const u8 = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  if (u8.byteLength < 16) throw new Error("File too small");

  let lastErr = null;
  for (let i = 0; i < TQ_PS_BASES.length; i++) {
    try {
      return await tqProcessOnBase(TQ_PS_BASES[i], u8, filename || "video.mp4", onProgress);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("All TikQuick PS endpoints failed");
}

// Long-lived port: chunked transfer from mp4-patch.js, then TikQuick process
chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "ryu-tq-patch") return;

  let filename = "video.mp4";
  let totalSize = 0;
  let totalChunks = 0;
  let received = [];
  let receivedCount = 0;
  let started = false;

  const report = (info) => {
    try {
      port.postMessage({ type: "progress", phase: info.phase, percent: info.percent });
    } catch (_) {}
  };

  const fail = (message) => {
    const text = message == null ? "unknown error" : String(message);
    console.error("[1dleryu TQ] ERROR: " + text);
    try {
      chrome.storage.local.set({ ryu_tq_last_error: text, ryu_tq_last_error_at: Date.now() });
    } catch (_) {}
    try {
      port.postMessage({ type: "error", message: text });
    } catch (_) {}
  };

  const runProcess = (u8) => {
    if (started) return;
    started = true;
    console.log("[1dleryu TQ] start patch: " + filename + " (" + u8.byteLength + " bytes)");
    tqProcessVideo(u8, filename, report)
      .then((output) => {
        console.log("[1dleryu TQ] done: " + (output && output.byteLength) + " bytes");
        try {
          port.postMessage({ type: "done", output: output });
        } catch (e) {
          fail("Failed to return patched video: " + (e && e.message ? e.message : String(e)));
        }
      })
      .catch((err) => {
        fail(err && err.message ? err.message : String(err));
      });
  };

  // Tell content script we are ready to receive slices
  try {
    port.postMessage({ type: "ready" });
  } catch (e) {
    fail("Port ready failed: " + (e && e.message ? e.message : String(e)));
    return;
  }

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "META") {
      filename = msg.filename || "video.mp4";
      totalSize = msg.totalSize | 0;
      totalChunks = msg.totalChunks | 0;
      received = new Array(totalChunks);
      receivedCount = 0;
      if (totalSize < 16 || totalChunks < 1) {
        fail("Invalid META (size=" + totalSize + ", chunks=" + totalChunks + ")");
      }
      return;
    }

    if (msg.type === "SLICE") {
      const index = msg.index | 0;
      let part = null;
      const buf = msg.buffer;
      try {
        if (buf instanceof ArrayBuffer) part = new Uint8Array(buf);
        else if (buf instanceof Uint8Array) part = buf;
        else if (buf && buf.buffer instanceof ArrayBuffer) {
          part = new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength || 0);
        }
      } catch (e) {
        fail("SLICE normalize failed: " + (e && e.message ? e.message : String(e)));
        return;
      }
      if (!part || !part.byteLength) {
        fail("Empty SLICE at index " + index);
        return;
      }
      if (index < 0 || index >= totalChunks) {
        fail("SLICE index out of range: " + index);
        return;
      }
      if (!received[index]) {
        received[index] = part;
        receivedCount += 1;
      }
      report({
        phase: "auth",
        percent: Math.min(5, (receivedCount / Math.max(1, totalChunks)) * 5)
      });
      return;
    }

    if (msg.type === "END") {
      if (receivedCount !== totalChunks) {
        fail("Missing slices: got " + receivedCount + " / " + totalChunks);
        return;
      }
      const out = new Uint8Array(totalSize);
      let offset = 0;
      for (let i = 0; i < totalChunks; i++) {
        const part = received[i];
        if (!part) {
          fail("Missing slice " + i);
          return;
        }
        out.set(part, offset);
        offset += part.byteLength;
      }
      if (offset !== totalSize) {
        // allow minor mismatch if last slice shorter — use actual
        console.warn("[1dleryu TQ] assembled " + offset + " vs declared " + totalSize);
      }
      runProcess(out.subarray(0, offset));
      return;
    }

    // Legacy single-buffer PATCH (compat)
    if (msg.type === "PATCH") {
      let u8 = null;
      const buffer = msg.buffer;
      try {
        if (buffer instanceof ArrayBuffer) u8 = new Uint8Array(buffer);
        else if (buffer instanceof Uint8Array) u8 = buffer;
        else if (buffer && buffer.buffer instanceof ArrayBuffer) {
          u8 = new Uint8Array(buffer.buffer, buffer.byteOffset || 0, buffer.byteLength || 0);
        }
      } catch (e) {
        fail("Buffer normalize failed: " + (e && e.message ? e.message : String(e)));
        return;
      }
      if (!u8 || u8.byteLength < 16) {
        fail("Invalid or empty video buffer in SW");
        return;
      }
      filename = msg.filename || filename;
      runProcess(u8);
    }
  });
});
