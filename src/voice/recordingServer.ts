// ---------------------------------------------------------------------------
// Ephemeral local HTTP server that serves a recording page and receives
// audio via POST. Used because VS Code webviews cannot access getUserMedia
// (the Permissions Policy iframe attribute `allow="microphone"` is not set
// by VS Code's webview host). The system browser has full mic access.
// ---------------------------------------------------------------------------

import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';

export interface RecordingResult {
  buffer: Buffer;
  mimeType: string;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function recordingPageHtml(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SideCar – Voice Input</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1e1e2e;color:#cdd6f4}
    h1{font-size:1.1rem;font-weight:500;margin-bottom:2rem;opacity:.8}
    #btn{width:80px;height:80px;border-radius:50%;border:none;cursor:pointer;font-size:2rem;background:#313244;color:#cdd6f4;transition:background .2s,transform .2s}
    #btn.recording{background:#f38ba8;animation:pulse 1s ease-in-out infinite}
    #btn:disabled{opacity:.4;cursor:default}
    @keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
    #status{margin-top:1.2rem;font-size:.85rem;color:#a6adc8;min-height:1.4em;text-align:center;max-width:280px}
    #submit{margin-top:1.4rem;padding:.45rem 1.4rem;border:none;border-radius:6px;background:#89b4fa;color:#1e1e2e;font-size:.9rem;font-weight:600;cursor:pointer;display:none}
    #submit:hover{background:#74c7ec}
    #submit:disabled{opacity:.5;cursor:default}
  </style>
</head>
<body>
  <h1>SideCar Voice Input</h1>
  <button id="btn" aria-label="Start recording">&#127908;</button>
  <div id="status">Click to start recording</div>
  <button id="submit">Send to SideCar &#8599;</button>
  <script>
    const btn = document.getElementById('btn');
    const status = document.getElementById('status');
    const submitBtn = document.getElementById('submit');
    const TOKEN = '${token}';
    let recorder = null, chunks = [], mimeType = 'audio/webm', blob = null;

    btn.addEventListener('click', async () => {
      if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm' : 'audio/webm';
        recorder = new MediaRecorder(stream, { mimeType });
        chunks = [];
        recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
          blob = new Blob(chunks, { type: mimeType });
          stream.getTracks().forEach(t => t.stop());
          btn.classList.remove('recording');
          btn.textContent = '\\u2713';
          status.textContent = 'Recording complete (' + (blob.size / 1024).toFixed(1) + ' KB)';
          submitBtn.style.display = 'inline-block';
        };
        recorder.start();
        btn.classList.add('recording');
        btn.textContent = '\\u23f9';
        status.textContent = 'Recording\\u2026 click to stop';
      } catch (e) {
        status.textContent = (e.name === 'NotAllowedError' ? 'Microphone permission denied.' : e.message);
      }
    });

    submitBtn.addEventListener('click', async () => {
      if (!blob) return;
      submitBtn.disabled = true;
      status.textContent = 'Sending\\u2026';
      try {
        const r = await fetch('/audio?token=' + TOKEN, { method: 'POST', headers: { 'Content-Type': mimeType }, body: blob });
        if (!r.ok) throw new Error('Server error ' + r.status);
        status.textContent = '\\u2713 Done! You can close this tab.';
        submitBtn.style.display = 'none';
        setTimeout(() => window.close(), 1800);
      } catch (e) {
        status.textContent = e.message;
        submitBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

export class VoiceRecordingSession {
  readonly url: string;
  private readonly _server: http.Server;
  private _resolve?: (r: RecordingResult) => void;
  private _reject?: (e: Error) => void;
  private _timer?: ReturnType<typeof setTimeout>;
  private _disposed = false;

  private constructor(
    private readonly port: number,
    private readonly token: string,
  ) {
    this.url = `http://127.0.0.1:${port}/?token=${token}`;
    this._server = this._buildServer();
  }

  static async create(): Promise<VoiceRecordingSession> {
    const port = await findFreePort();
    const token = crypto.randomBytes(16).toString('hex');
    return new VoiceRecordingSession(port, token);
  }

  waitForAudio(timeoutMs = 120_000): Promise<RecordingResult> {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this._timer = setTimeout(() => {
        this.dispose();
        reject(new Error('Voice recording timed out.'));
      }, timeoutMs);
    });
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    this._server.close();
  }

  private _buildServer(): http.Server {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
      const tok = url.searchParams.get('token');
      if (tok !== this.token) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(recordingPageHtml(this.token));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/audio') {
        const rawMime = req.headers['content-type'] ?? 'audio/webm';
        const mimeType = rawMime.split(';')[0].trim();
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200).end('OK');
          if (this._timer !== undefined) {
            clearTimeout(this._timer);
            this._timer = undefined;
          }
          this._resolve?.({ buffer: Buffer.concat(chunks), mimeType });
          // Close after response is flushed so the browser can read the 200.
          setTimeout(() => this.dispose(), 500);
        });
        return;
      }

      res.writeHead(404).end('Not found');
    });

    server.listen(this.port, '127.0.0.1');
    return server;
  }
}
