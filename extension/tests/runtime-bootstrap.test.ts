import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { resolve } from 'node:path';
import common from '../config/esbuild.common';
import { webcrypto } from 'node:crypto';

const bootstrap = buildSync({
    entryPoints: [resolve(__dirname, '../src/runtime-bootstrap.ts')],
    bundle: true, write: false, platform: 'browser', format: 'iife',
}).outputFiles[0].text;
const integrated = buildSync({
    ...common, entryPoints: undefined, outdir: undefined, write: false,
    stdin: {
        contents: `import PQueue from 'p-queue';
            import { withTimeout } from './timeout';
            import { makeSourceId } from './eda/source-document';
            import { CheckpointScopes } from './eda/checkpoint-scopes';
            // Exercise capabilities during module initialization, not only after it.
            const controller = new AbortController();
            const cloned = structuredClone({ nested: { value: 1 } });
            const sourceId = makeSourceId();
            export { PQueue, withTimeout, controller, cloned, sourceId, makeSourceId, CheckpointScopes };`,
        loader: 'ts', resolveDir: resolve(__dirname, '../src'),
    },
}).outputFiles[0].text;

function fixture(native = true, timers: 'system' | 'reject' | 'throw' | 'absent' = 'system') {
    const active = new Map<string, ReturnType<typeof setTimeout>>();
    const logs: string[] = [];
    const eda = {
        sys_Log: { add(message: string) { logs.push(message); } },
        sys_Timer: timers === 'absent' ? undefined : {
            setTimeoutTimer(id: string, delay: number, callback: () => void) {
                if (timers === 'throw') throw Error('Unavailable system timer');
                if (timers === 'reject') return false;
                active.set(id, setTimeout(() => { active.delete(id); callback(); }, delay));
                return true;
            },
            setIntervalTimer(id: string, delay: number, callback: () => void) {
                if (timers === 'throw') throw Error('Unavailable system timer');
                if (timers === 'reject') return false;
                active.set(id, setInterval(callback, delay));
                return true;
            },
            clearTimeoutTimer(id: string) {
                clearTimeout(active.get(id));
                return active.delete(id);
            },
            clearIntervalTimer(id: string) {
                clearInterval(active.get(id));
                return active.delete(id);
            },
        },
    };
    const host = { ...(native ? { AbortController, structuredClone, queueMicrotask } : {}), crypto: native ? webcrypto : undefined,
        setTimeout, setInterval, clearTimeout, clearInterval };
    // Mirror the installed JLCEDA runner: own undefined bindings hide host globals.
    const bindings = { AbortController: undefined, structuredClone: undefined, queueMicrotask: undefined,
        crypto: undefined as unknown,
        window: undefined, Event: undefined, EventTarget: undefined,
        setTimeout, setInterval, clearTimeout, clearInterval, eda };
    const sandbox = new Proxy(bindings, {
        has(target, key) { return key in target; },
        get(target, key, receiver) {
            if (key === Symbol.unscopables) return undefined;
            const value = Reflect.get(target, key, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, key, value) { Reflect.set(target, key, value); return true; },
    });
    const context = createContext({ sandbox, globalThis: host });
    const evaluate = (code: string) => runInContext(`with (sandbox) { ${code} }`, context);
    const execute = (code: string) => evaluate(`(async () => { ${code} })()`);
    return { context, bindings, host, eda, active, logs, evaluate, execute,
        install: () => evaluate(bootstrap),
        dispose() { for (const timer of active.values()) clearInterval(timer); active.clear(); },
    };
}

test('build injection restores capabilities before dependency initialization in the JLCEDA sandbox', async () => {
    const f = fixture();
    try {
        f.evaluate(integrated);
        const result = await f.execute(`
            const { PQueue, controller, cloned } = edaEsbuildExportName;
            controller.abort('probe');
            const queue = new PQueue({ concurrency: 5 });
            const tasks = Array.from({ length: 12 }, (_, i) => () => i);
            const values = await queue.addAll(tasks);
            await queue.onIdle();
            return { aborted: controller.signal.aborted, reason: controller.signal.reason,
                cloned: cloned.nested.value, values, pending: queue.pending, size: queue.size };
        `);
        assert.deepEqual(JSON.parse(JSON.stringify(result)), { aborted: true, reason: 'probe', cloned: 1,
            values: Array.from({ length: 12 }, (_, i) => i), pending: 0, size: 0 });
        assert.equal(f.host.AbortController, AbortController);
        assert.equal(f.host.structuredClone, structuredClone);
        assert.equal(f.host.queueMicrotask, queueMicrotask);
    } finally { f.dispose(); }
});

test('missing host APIs use fallbacks for cancellation, timeouts and repeated queue tasks', async () => {
    const f = fixture(false);
    try {
        f.evaluate(integrated);
        const result = await f.execute(`
            const { PQueue, withTimeout } = edaEsbuildExportName;
            const queue = new PQueue({ concurrency: 1 });
            let resume;
            let lateWork = false;
            const first = queue.add(() => withTimeout(async signal => {
                await new Promise(resolve => { resume = resolve; });
                signal.throwIfAborted(); lateWork = true;
            }, 10, 'expired'));
            const second = queue.add(() => 'next');
            let error;
            try { await first; } catch (e) { error = e.message; }
            const next = await second;
            resume();
            await queue.onIdle();
            await new Promise(resolve => queueMicrotask(resolve));
            return { error, next, lateWork, pending: queue.pending };
        `);
        assert.deepEqual(JSON.parse(JSON.stringify(result)), { error: 'expired', next: 'next', lateWork: false, pending: 0 });
        assert.equal(f.active.size, 0);
    } finally { f.dispose(); }
});

test('fallback signal handles once, listener removal, thrown listeners and idempotent abort', async () => {
    const f = fixture(false);
    f.install();
    const result = await f.execute(`
        const controller = new AbortController(); const signal = controller.signal;
        let count = 0; let removed = 0; let onabort = 0;
        const fn = () => count++;
        const remove = () => removed++;
        signal.addEventListener('abort', fn, { once: true });
        signal.addEventListener('abort', fn);
        signal.addEventListener('abort', remove);
        signal.removeEventListener('abort', remove);
        signal.addEventListener('abort', () => { throw Error('listener failure'); });
        signal.onabort = () => onabort++;
        controller.abort('first'); controller.abort('second');
        let thrown; try { signal.throwIfAborted(); } catch (e) { thrown = e; }
        const defaultController = new AbortController(); defaultController.abort();
        return { count, removed, onabort, reason: signal.reason, thrown,
            defaultName: defaultController.signal.reason.name };
    `);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { count: 1, removed: 0, onabort: 1,
        reason: 'first', thrown: 'first', defaultName: 'AbortError' });
    assert.ok(f.logs.some(message => message.includes('listener failure')));
});

test('record clone preserves cycles, aliases, undefined, sparse arrays and __proto__ data', async () => {
    const f = fixture(false);
    f.install();
    const result = await f.execute(`
        const shared = { value: 1 }; const array = new Array(3); array[2] = undefined;
        const source = { a: shared, b: shared, missing: undefined, array };
        source.self = source;
        Object.defineProperty(source, '__proto__', { value: { marker: 7 }, enumerable: true });
        const cloned = structuredClone(source);
        let unsupported; try { structuredClone({ date: new Date() }); } catch (e) { unsupported = e.name; }
        let transfer; try { structuredClone({}, { transfer: [new ArrayBuffer(1)] }); } catch (e) { transfer = e.name; }
        return { independent: cloned.a !== shared, alias: cloned.a === cloned.b,
            cycle: cloned.self === cloned, undefinedKept: 'missing' in cloned,
            length: cloned.array.length, hole: !(0 in cloned.array), valueKept: 2 in cloned.array,
            ownProto: Object.hasOwn(cloned, '__proto__'), protoMarker: cloned.__proto__.marker,
            noPrototypePollution: Object.getPrototypeOf(cloned).marker === undefined, unsupported, transfer };
    `);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { independent: true, alias: true, cycle: true,
        undefinedKept: true, length: 3, hole: true, valueKept: true, ownProto: true,
        protoMarker: 7, noPrototypePollution: true, unsupported: 'DataCloneError', transfer: 'DataCloneError' });
});

for (const mode of ['system', 'reject', 'throw', 'absent'] as const) {
    test(`timers preserve arguments, cancellation and repeated initialization (${mode})`, async () => {
        const f = fixture(true, mode);
        try {
            f.install();
            const handle = await f.execute(`return setTimeout(() => { eda.cancelledRan = true; }, 10);`);
            const timerFunction = f.bindings.setTimeout;
            f.install();
            assert.equal(f.bindings.setTimeout, timerFunction);
            await f.execute(`
                clearInterval(${handle});
                let ticks = 0;
                await new Promise(resolve => {
                    const id = setInterval((a, b) => {
                        eda.argumentsSeen = [a, b];
                        if (++ticks === 2) { clearTimeout(id); resolve(); }
                    }, 2, 'first', { value: 2 });
                });
                await new Promise(resolve => setTimeout(resolve, 15));
            `);
            assert.deepEqual(JSON.parse(JSON.stringify((f.eda as any).argumentsSeen)), ['first', { value: 2 }]);
            assert.equal((f.eda as any).cancelledRan, undefined);
            assert.equal(f.active.size, 0);
            assert.equal((f.eda as any).__copilotRuntimeTimers?.entries.size ?? 0, 0);
            assert.throws(() => f.evaluate(`setTimeout('not a callback', 0)`), /callback.*function/);
        } finally { f.dispose(); }
    });
}

test('working sandbox implementations are preserved instead of being replaced by host versions', () => {
    const f = fixture();
    const controller = class {};
    const clone = () => 'existing';
    const microtask = () => {};
    Object.assign(f.bindings, { AbortController: controller, structuredClone: clone, queueMicrotask: microtask });
    f.install();
    assert.equal(f.bindings.AbortController, controller);
    assert.equal(f.bindings.structuredClone, clone);
    assert.equal(f.bindings.queueMicrotask, microtask);
});

test('ordinary globals work when SYS_Timer itself uses the replaced global timers', async () => {
    const context = createContext({ AbortController, structuredClone, queueMicrotask, crypto: webcrypto,
        setTimeout, setInterval, clearTimeout, clearInterval });
    // Define SYS_Timer in the same realm so its calls resolve the replaced bindings.
    runInContext(`
        const active = new Map();
        const eda = { sys_Log: { add() {} }, sys_Timer: {
            setTimeoutTimer(id, delay, callback) {
                active.set(id, setTimeout(() => { active.delete(id); callback(); }, delay)); return true;
            },
            setIntervalTimer(id, delay, callback) {
                active.set(id, setInterval(callback, delay)); return true;
            },
            clearTimeoutTimer(id) { clearTimeout(active.get(id)); return active.delete(id); },
            clearIntervalTimer(id) { clearInterval(active.get(id)); return active.delete(id); }
        }};
    `, context);
    runInContext(integrated, context);
    const result = await runInContext(`(async () => {
        const controller = new AbortController(); controller.abort('ordinary');
        const values = await new edaEsbuildExportName.PQueue({ concurrency: 1 }).addAll([() => 1, () => 2]);
        let cancelledRan = false;
        clearInterval(setTimeout(() => { cancelledRan = true; }, 5));
        let ticks = 0;
        await new Promise(resolve => {
            const handle = setInterval(() => { if (++ticks === 2) { clearTimeout(handle); resolve(); } }, 2);
        });
        // Exercise a direct SYS_Timer caller alongside the browser-style wrappers.
        await new Promise(resolve => eda.sys_Timer.setTimeoutTimer('direct', 10, resolve));
        return { reason: controller.signal.reason, values, cancelledRan, ticks,
            active: active.size, registered: eda.__copilotRuntimeTimers.entries.size,
            controllerPreserved: AbortController === globalThis.AbortController };
    })()`, context);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { reason: 'ordinary', values: [1, 2],
        cancelledRan: false, ticks: 2, active: 0, registered: 0, controllerPreserved: true });
});

test('shadowed crypto is restored from the host without modifying native methods', () => {
    const f = fixture();
    f.evaluate(integrated);
    assert.equal(f.bindings.crypto, webcrypto);
    assert.equal(f.host.crypto, webcrypto);
    assert.match(f.evaluate('edaEsbuildExportName.sourceId'), /^[0-9a-f]{16}$/);
});

test('existing sandbox crypto is preserved', () => {
    const f = fixture();
    f.bindings.crypto = webcrypto;
    f.install();
    assert.equal(f.bindings.crypto, webcrypto);
});

test('UUID fallback uses native random bytes with the correct receiver and preserves other crypto properties', () => {
    const f = fixture(false);
    const subtle = {};
    const source = {
        getRandomValues(bytes: Uint8Array) { assert.equal(this, source); bytes.fill(0xab); return bytes; },
        get subtle() { assert.equal(this, source); return subtle; },
    };
    Object.assign(f.host, { crypto: source });
    f.install();
    assert.equal(f.evaluate('crypto.randomUUID()'), 'abababab-abab-4bab-abab-abababababab');
    assert.equal(f.evaluate('crypto.getRandomValues(new Uint8Array(1))[0]'), 0xab);
    assert.equal(f.evaluate('crypto.subtle'), subtle);
    assert.equal(Object.hasOwn(source, 'randomUUID'), false);
});

test('partial sandbox crypto borrows host UUID without replacing its existing methods', () => {
    const f = fixture();
    const source = {
        getRandomValues(bytes: Uint8Array) { assert.equal(this, source); bytes.fill(7); return bytes; },
    };
    f.bindings.crypto = source;
    f.install();
    assert.match(f.evaluate('crypto.randomUUID()'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(f.evaluate('crypto.getRandomValues(new Uint8Array(1))[0]'), 7);
    assert.equal(Object.hasOwn(source, 'randomUUID'), false);
});

test('absent crypto supports document IDs and real checkpoint scopes without claiming secure random bytes', async () => {
    const f = fixture(false);
    f.evaluate(integrated);
    const ids = f.evaluate('Array.from({ length: 128 }, () => crypto.randomUUID())') as string[];
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(f.evaluate('typeof crypto.getRandomValues'), 'undefined');
    assert.equal(f.host.crypto, undefined);
    const result = await f.execute(`
        const { CheckpointScopes, sourceId, makeSourceId } = edaEsbuildExportName;
        const scopes = new CheckpointScopes({ save: async () => 'checkpoint', pin() {}, unpin() {} });
        const api = { dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'document' }) } };
        const begin = await scopes.execute({ checkpointScope: { action: 'begin', sessionId: 'probe', name: 'Crypto compatibility' } }, api, 1);
        const end = await scopes.execute({ checkpointScope: { action: 'end', sessionId: 'probe', token: begin.checkpointScope?.token } }, api, 1);
        return { sourceId, nextSourceId: makeSourceId(), token: begin.checkpointScope?.token,
            checkpoint: begin.checkpoint, ended: !end.error };
    `);
    assert.match(result.sourceId, /^[0-9a-f]{16}$/);
    assert.match(result.nextSourceId, /^[0-9a-f]{16}$/);
    assert.notEqual(result.sourceId, result.nextSourceId);
    assert.match(result.token, /^[0-9a-f-]{36}$/);
    assert.equal(result.checkpoint, 'checkpoint');
    assert.equal(result.ended, true);
});
