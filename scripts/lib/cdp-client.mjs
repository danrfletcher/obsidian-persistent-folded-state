/**
 * Minimal Chrome DevTools Protocol client for scripts/e2e-embed-probe.mjs (the other probes keep
 * their own copies; this one is shared only so the embed probe stays one readable file).
 *
 * Two transports, same interface:
 *   - direct: Node's global WebSocket to 127.0.0.1:<cdpPort> (the probe runs where Obsidian's
 *     remote-debugging port is reachable).
 *   - docker: the desktop container publishes only its VNC port and has no Node, so the probe can
 *     run on the host instead: `docker exec -i <container> python3 -c <relay>` bridges the
 *     container's loopback CDP port to this process's stdio, and a small RFC 6455 client speaks
 *     WebSocket over that pipe (client frames masked, server frames unmasked, text frames,
 *     fragmentation, ping/pong and close handled; no extensions, no compression).
 */
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RELAY_PY = `
import socket, sys, threading
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
def pump_in():
    try:
        while True:
            d = sys.stdin.buffer.read1(65536)
            if not d:
                break
            s.sendall(d)
    finally:
        try: s.shutdown(socket.SHUT_WR)
        except Exception: pass
threading.Thread(target=pump_in, daemon=True).start()
try:
    while True:
        d = s.recv(65536)
        if not d:
            break
        sys.stdout.buffer.write(d)
        sys.stdout.buffer.flush()
except Exception:
    pass
`;

/** Lists debuggable targets (the same JSON `http://127.0.0.1:<port>/json/list` serves). */
export async function listTargets({ cdpPort, docker }) {
	if (docker) {
		const { stdout } = await execFileAsync("docker", ["exec", docker, "curl", "-sf", `http://127.0.0.1:${cdpPort}/json/list`], {
			maxBuffer: 16 * 1024 * 1024,
		});
		return JSON.parse(stdout);
	}
	const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
	if (!res.ok) throw new Error(`CDP target list request failed: HTTP ${res.status}`);
	return res.json();
}

/** A bare duplex-ish WebSocket over a child process's stdio (see the file comment). */
class PipeWebSocket {
	constructor(child, host, path, onMessage, onClose) {
		this.child = child;
		this.onMessage = onMessage;
		this.onClose = onClose;
		this.buffer = Buffer.alloc(0);
		this.handshakeDone = false;
		this.fragments = [];
		this.closed = false;
		const key = randomBytes(16).toString("base64");
		this.expectedAccept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
		this.ready = new Promise((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		child.stdout.on("data", (chunk) => this.onData(chunk));
		child.on("exit", () => this.finish(new Error("CDP relay exited")));
		child.on("error", (err) => this.finish(err));
		child.stdin.on("error", () => {});
		child.stdin.write(
			[
				`GET ${path} HTTP/1.1`,
				`Host: ${host}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Key: ${key}`,
				"Sec-WebSocket-Version: 13",
				"",
				"",
			].join("\r\n")
		);
	}

	finish(err) {
		if (this.closed) return;
		this.closed = true;
		if (!this.handshakeDone) this.rejectReady(err);
		this.onClose(err);
	}

	onData(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		if (!this.handshakeDone) {
			const end = this.buffer.indexOf("\r\n\r\n");
			if (end === -1) return;
			const head = this.buffer.subarray(0, end).toString("utf8");
			this.buffer = this.buffer.subarray(end + 4);
			if (!/^HTTP\/1\.1 101/.test(head)) return this.finish(new Error(`WebSocket upgrade refused: ${head.split("\r\n")[0]}`));
			const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
			if (accept !== this.expectedAccept) return this.finish(new Error("WebSocket accept key mismatch"));
			this.handshakeDone = true;
			this.resolveReady();
		}
		this.drainFrames();
	}

	drainFrames() {
		for (;;) {
			const buf = this.buffer;
			if (buf.length < 2) return;
			const fin = (buf[0] & 0x80) !== 0;
			const opcode = buf[0] & 0x0f;
			let len = buf[1] & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (buf.length < 4) return;
				len = buf.readUInt16BE(2);
				offset = 4;
			} else if (len === 127) {
				if (buf.length < 10) return;
				len = Number(buf.readBigUInt64BE(2));
				offset = 10;
			}
			if (buf.length < offset + len) return;
			const payload = buf.subarray(offset, offset + len);
			this.buffer = buf.subarray(offset + len);
			if (opcode === 0x8) return this.finish(new Error("CDP socket closed"));
			if (opcode === 0x9) {
				this.writeFrame(0xa, payload);
				continue;
			}
			if (opcode === 0xa) continue;
			this.fragments.push(payload);
			if (fin) {
				const text = Buffer.concat(this.fragments).toString("utf8");
				this.fragments = [];
				this.onMessage(text);
			}
		}
	}

	writeFrame(opcode, payload) {
		const mask = randomBytes(4);
		let header;
		if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
		else if (payload.length < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 126;
			header.writeUInt16BE(payload.length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(payload.length), 2);
		}
		const masked = Buffer.from(payload);
		for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
		this.child.stdin.write(Buffer.concat([header, mask, masked]));
	}

	send(text) {
		this.writeFrame(0x1, Buffer.from(text, "utf8"));
	}

	close() {
		if (this.closed) return;
		try {
			this.writeFrame(0x8, Buffer.alloc(0));
		} catch {
			/* already gone */
		}
		this.child.kill();
	}
}

function openSocket({ docker, cdpPort, webSocketDebuggerUrl }, onMessage, onClose) {
	if (!docker) {
		const ws = new WebSocket(webSocketDebuggerUrl);
		const ready = new Promise((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", (err) => reject(err instanceof Error ? err : new Error("CDP socket error")));
		});
		ws.addEventListener("message", (event) => onMessage(event.data.toString()));
		ws.addEventListener("close", () => onClose(new Error("CDP socket closed")));
		return { ready, send: (text) => ws.send(text), close: () => ws.readyState === WebSocket.OPEN && ws.close() };
	}
	const url = new URL(webSocketDebuggerUrl);
	const child = spawn("docker", ["exec", "-i", docker, "python3", "-u", "-c", RELAY_PY, String(cdpPort)], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	const ws = new PipeWebSocket(child, url.host, url.pathname, onMessage, onClose);
	return { ready: ws.ready, send: (text) => ws.send(text), close: () => ws.close() };
}

/**
 * Connects to one debuggable page. `targetFilter(target)` picks the page (default: the first
 * `type === "page"` target whose url is the Obsidian app, not about:blank).
 */
export async function connectCdp({ cdpPort = 9222, docker = null, targetFilter } = {}) {
	const targets = await listTargets({ cdpPort, docker });
	const pick = targetFilter ?? ((t) => t.type === "page" && t.webSocketDebuggerUrl && t.url.startsWith("app://obsidian.md"));
	const target = targets.find(pick);
	if (!target) throw new Error("no debuggable Obsidian window found on that CDP port");

	let nextId = 1;
	let closed = false;
	const pending = new Map();
	const rejectAllPending = (err) => {
		for (const { reject } of pending.values()) reject(err);
		pending.clear();
	};
	const socket = openSocket(
		{ docker, cdpPort, webSocketDebuggerUrl: target.webSocketDebuggerUrl },
		(text) => {
			const message = JSON.parse(text);
			if (message.id && pending.has(message.id)) {
				const { resolve, reject } = pending.get(message.id);
				pending.delete(message.id);
				if (message.error) reject(new Error(message.error.message));
				else resolve(message.result);
			}
		},
		(err) => {
			closed = true;
			rejectAllPending(err);
		}
	);
	await socket.ready;

	async function send(method, params = {}, { timeoutMs = 15000 } = {}) {
		if (closed) throw new Error(`CDP socket already closed, cannot send ${method}`);
		const id = nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			pending.set(id, {
				resolve: (value) => (clearTimeout(timer), resolve(value)),
				reject: (err) => (clearTimeout(timer), reject(err)),
			});
			socket.send(JSON.stringify({ id, method, params }));
		});
	}

	async function evaluate(expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, { timeoutMs });
		if (result.exceptionDetails) {
			const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
			throw new Error(`Runtime.evaluate threw: ${text}`);
		}
		return result.result.value;
	}

	return { send, evaluate, close: () => socket.close(), target };
}
