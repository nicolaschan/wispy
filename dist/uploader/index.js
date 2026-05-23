import './sourcemap-register.cjs';import { createRequire as __WEBPACK_EXTERNAL_createRequire } from "module";
/******/ /* webpack/runtime/compat */
/******/ 
/******/ if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = new URL('.', import.meta.url).pathname.slice(import.meta.url.match(/^file:\/\/\/\w:/) ? 1 : 0, -1) + "/";
/******/ 
/************************************************************************/
var __webpack_exports__ = {};

;// CONCATENATED MODULE: external "node:fs"
const external_node_fs_namespaceObject = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:fs");
;// CONCATENATED MODULE: external "node:fs/promises"
const promises_namespaceObject = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:fs/promises");
;// CONCATENATED MODULE: external "node:child_process"
const external_node_child_process_namespaceObject = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:child_process");
;// CONCATENATED MODULE: external "node:util"
const external_node_util_namespaceObject = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:util");
;// CONCATENATED MODULE: ./src/queue.ts
const SENTINEL = '__WISPY_EOF__';
class QueueParser {
    buffer = '';
    seen = new Set();
    feed(chunk) {
        this.buffer += chunk;
        const newlineIdx = this.buffer.lastIndexOf('\n');
        if (newlineIdx === -1) {
            return { paths: [], sentinelSeen: false };
        }
        const complete = this.buffer.slice(0, newlineIdx);
        this.buffer = this.buffer.slice(newlineIdx + 1);
        const paths = [];
        let sentinelSeen = false;
        for (const line of complete.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            if (trimmed === SENTINEL) {
                sentinelSeen = true;
                break;
            }
            for (const path of trimmed.split(/\s+/)) {
                if (!path || this.seen.has(path))
                    continue;
                this.seen.add(path);
                paths.push(path);
            }
        }
        return { paths, sentinelSeen };
    }
}

;// CONCATENATED MODULE: ./src/uploader.ts





const exec = (0,external_node_util_namespaceObject.promisify)(external_node_child_process_namespaceObject.execFile);
function envOrThrow(key) {
    const v = process.env[key];
    if (!v)
        throw new Error(`Uploader missing env var: ${key}`);
    return v;
}
function readEnv() {
    return {
        queueFile: envOrThrow('WISPY_QUEUE_FILE'),
        statusFile: envOrThrow('WISPY_STATUS_FILE'),
        destUrl: envOrThrow('WISPY_DEST_URL'),
        concurrency: Number.parseInt(envOrThrow('WISPY_UPLOAD_CONCURRENCY'), 10),
    };
}
async function copyPath(destUrl, path) {
    // `nix copy --to <url> <path>` uploads the path's signed NAR + narinfo.
    // Stderr contains progress; we don't parse it for byte counts in v1.
    // Returns 0 for bytes (we don't know without a separate `nix path-info -s`).
    await exec('nix', ['copy', '--to', destUrl, path], { maxBuffer: 64 * 1024 * 1024 });
    return 0;
}
async function pathSize(path) {
    try {
        const { stdout } = await exec('nix', ['path-info', '--json', '-s', path], {
            maxBuffer: 4 * 1024 * 1024,
        });
        const parsed = JSON.parse(stdout);
        if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object') {
            const obj = parsed[0];
            const v = obj.narSize;
            if (typeof v === 'number')
                return v;
        }
        else if (parsed && typeof parsed === 'object') {
            const entries = Object.values(parsed);
            const first = entries[0];
            if (first && typeof first === 'object') {
                const v = first.narSize;
                if (typeof v === 'number')
                    return v;
            }
        }
        return 0;
    }
    catch {
        return 0;
    }
}
class WorkPool {
    limit;
    active = 0;
    waiters = [];
    constructor(limit) {
        this.limit = limit;
    }
    async run(fn) {
        while (this.active >= this.limit) {
            await new Promise((resolve) => this.waiters.push(resolve));
        }
        this.active++;
        try {
            return await fn();
        }
        finally {
            this.active--;
            const next = this.waiters.shift();
            if (next)
                next();
        }
    }
}
async function main() {
    const env = readEnv();
    const started = Date.now();
    const parser = new QueueParser();
    const pool = new WorkPool(env.concurrency);
    const status = { pathsPushed: 0, bytesPushed: 0, pathsFailed: 0, wallTimeMs: 0 };
    const inflight = [];
    let offset = 0;
    let sentinelSeen = false;
    // Ensure queue file exists so we can open it.
    await external_node_fs_namespaceObject.promises.writeFile(env.queueFile, '', { flag: 'a' });
    while (!sentinelSeen) {
        const st = await (0,promises_namespaceObject.stat)(env.queueFile).catch(() => null);
        if (st && st.size > offset) {
            const fd = await (0,promises_namespaceObject.open)(env.queueFile, 'r');
            try {
                const len = st.size - offset;
                const buf = Buffer.alloc(len);
                await fd.read(buf, 0, len, offset);
                offset = st.size;
                const result = parser.feed(buf.toString('utf8'));
                if (result.sentinelSeen)
                    sentinelSeen = true;
                for (const path of result.paths) {
                    inflight.push(pool.run(async () => {
                        try {
                            await copyPath(env.destUrl, path);
                            const bytes = await pathSize(path);
                            status.pathsPushed++;
                            status.bytesPushed += bytes;
                            console.error(`uploaded ${path} (${bytes} bytes)`);
                        }
                        catch (err) {
                            status.pathsFailed++;
                            const msg = err instanceof Error ? err.message : String(err);
                            console.error(`WARN: failed to push ${path}: ${msg}`);
                        }
                    }));
                }
            }
            finally {
                await fd.close();
            }
        }
        else {
            await new Promise((r) => setTimeout(r, 250));
        }
    }
    await Promise.all(inflight);
    status.wallTimeMs = Date.now() - started;
    await (0,promises_namespaceObject.writeFile)(env.statusFile, JSON.stringify(status, null, 2));
}
main().catch((err) => {
    console.error(`uploader fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
});


//# sourceMappingURL=index.js.map