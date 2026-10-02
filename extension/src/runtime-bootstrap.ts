/** Injected by the build, before the background entry and its dependencies.
 * Assign bare names: JLCEDA's with(sandbox) shadows properties of globalThis.
 */
(() => {
    const host = typeof globalThis === 'object' ? globalThis : undefined;
    const reportError = (error: unknown) => {
        try { eda.sys_Log.add(`Copilot runtime: ${String(error)}`); } catch { /* No logger during startup. */ }
    };
    const enqueueMicrotask = typeof queueMicrotask === 'function' ? queueMicrotask
        : typeof host?.queueMicrotask === 'function' ? host.queueMicrotask.bind(host)
        : (callback: VoidFunction) => {
            if (typeof callback !== 'function') throw new TypeError('Microtask callback must be a function');
            void Promise.resolve().then(callback).catch(reportError);
        };
    // @ts-expect-error Node declarations mark this binding as a function; the EDA sandbox permits assignment.
    if (typeof queueMicrotask !== 'function') queueMicrotask = enqueueMicrotask;

    const namedError = (name: string, message: string) => {
        const error = new Error(message);
        error.name = name;
        return error;
    };
    const sandboxCrypto = typeof crypto === 'object' && crypto !== null ? crypto : undefined;
    const hostCrypto = typeof host?.crypto === 'object' && host.crypto !== null ? host.crypto : undefined;
    if (typeof sandboxCrypto?.randomUUID !== 'function') {
        const source = sandboxCrypto ?? hostCrypto;
        const nativeUuid = typeof hostCrypto?.randomUUID === 'function' ? hostCrypto.randomUUID.bind(hostCrypto) : undefined;
        const randomValues = typeof source?.getRandomValues === 'function' ? source.getRandomValues.bind(source)
            : typeof hostCrypto?.getRandomValues === 'function' ? hostCrypto.getRandomValues.bind(hostCrypto) : undefined;
        // Only the UUID operation used by Copilot is emulated. Math.random is a
        // last-resort identifier generator, never advertised as secure getRandomValues.
        const randomUuid = nativeUuid ?? (() => {
            const bytes = new Uint8Array(16);
            if (randomValues) randomValues(bytes);
            else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ReturnType<Crypto['randomUUID']>;
        });
        // Preserve native getters/receivers and do not modify the renderer's crypto object.
        crypto = !sandboxCrypto && nativeUuid ? hostCrypto! : new Proxy(source ?? {} as Crypto, {
            get(target, key) {
                if (key === 'randomUUID') return randomUuid;
                if (key === 'getRandomValues' && randomValues) return randomValues;
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
    }
    type Listener = { callback: EventListenerOrEventListenerObject; once: boolean; capture: boolean };
    // The cancellation contract used by Copilot; no dependency on Event/EventTarget.
    class CancellationSignal {
        aborted = false;
        reason: unknown;
        onabort: ((event: Event) => void) | null = null;
        private listeners: Listener[] = [];
        throwIfAborted() { if (this.aborted) throw this.reason; }
        addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
            if (type !== 'abort' || !callback) return;
            const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
            if (!this.listeners.some(item => item.callback === callback && item.capture === capture)) {
                this.listeners.push({ callback, capture, once: typeof options === 'object' && Boolean(options.once) });
            }
        }
        removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
            if (type !== 'abort') return;
            const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
            this.listeners = this.listeners.filter(item => item.callback !== callback || item.capture !== capture);
        }
        abort(reason: unknown) {
            if (this.aborted) return;
            this.aborted = true;
            this.reason = reason === undefined ? namedError('AbortError', 'This operation was aborted') : reason;
            const event = { type: 'abort', target: this, currentTarget: this } as unknown as Event;
            for (const item of [...this.listeners]) {
                if (!this.listeners.includes(item)) continue;
                if (item.once) this.removeEventListener('abort', item.callback, item.capture);
                try {
                    if (typeof item.callback === 'function') item.callback.call(this as unknown as EventTarget, event);
                    else item.callback.handleEvent(event);
                } catch (error) { reportError(error); }
            }
            try { this.onabort?.call(this, event); } catch (error) { reportError(error); }
        }
    }
    class CancellationController {
        readonly signal = new CancellationSignal();
        abort(reason?: unknown) { this.signal.abort(reason); }
    }
    if (typeof AbortController !== 'function') {
        AbortController = typeof host?.AbortController === 'function' ? host.AbortController
            : CancellationController as unknown as typeof AbortController;
    }

    if (typeof structuredClone !== 'function') {
        // Copilot clones records/arrays, not native EDA primitives. Reject unsupported
        // values rather than silently losing them with JSON.parse(JSON.stringify()).
        const cloneRecords = <T>(value: T, options?: StructuredSerializeOptions): T => {
            if (options?.transfer?.length) throw namedError('DataCloneError', 'Transfer is unavailable in the record clone fallback');
            const seen = new Map<object, unknown>();
            const copy = (input: unknown): unknown => {
                if (typeof input === 'function' || typeof input === 'symbol') throw namedError('DataCloneError', 'Value cannot be cloned');
                if (input === null || typeof input !== 'object') return input;
                if (seen.has(input)) return seen.get(input);
                if (!Array.isArray(input) && Object.prototype.toString.call(input) !== '[object Object]') {
                    throw namedError('DataCloneError', 'The clone fallback supports records and arrays only');
                }
                const result: Record<string, unknown> | unknown[] = Array.isArray(input) ? new Array(input.length) : {};
                seen.set(input, result);
                for (const key of Object.keys(input)) {
                    Object.defineProperty(result, key, {
                        value: copy((input as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true,
                    });
                }
                return result;
            };
            return copy(value) as T;
        };
        // @ts-expect-error Patch the sandbox binding, not the real renderer global.
        structuredClone = typeof host?.structuredClone === 'function' ? host.structuredClone.bind(host) : cloneRecords;
    }

    const timerApi = typeof eda === 'object' ? eda.sys_Timer : undefined;
    if (!timerApi || typeof timerApi.setTimeoutTimer !== 'function' || typeof timerApi.setIntervalTimer !== 'function'
        || typeof timerApi.clearTimeoutTimer !== 'function' || typeof timerApi.clearIntervalTimer !== 'function') return;
    type TimerEntry = { id: string; interval: boolean; nativeHandle?: number };
    type TimerState = { next: number; prefix: string; entries: Map<number, TimerEntry>; timeout: typeof setTimeout; interval: typeof setInterval; clear: typeof clearTimeout };
    const api = eda as typeof eda & { __copilotRuntimeTimers?: TimerState };
    const installTimers = (timers: TimerState) => {
        // @ts-expect-error Node declarations do not describe the writable EDA sandbox binding.
        setTimeout = timers.timeout;
        // @ts-expect-error See setTimeout above.
        setInterval = timers.interval;
        // @ts-expect-error See setTimeout above.
        clearTimeout = timers.clear;
        // @ts-expect-error See setTimeout above.
        clearInterval = timers.clear;
    };
    if (api.__copilotRuntimeTimers) {
        installTimers(api.__copilotRuntimeTimers);
        return; // Preserve live handles on repeated initialization.
    }
    const nativeTimeout = typeof setTimeout === 'function' ? setTimeout : host?.setTimeout?.bind(host);
    const nativeInterval = typeof setInterval === 'function' ? setInterval : host?.setInterval?.bind(host);
    const nativeClearTimeout = typeof clearTimeout === 'function' ? clearTimeout : host?.clearTimeout?.bind(host);
    const nativeClearInterval = typeof clearInterval === 'function' ? clearInterval : host?.clearInterval?.bind(host);
    const entries = new Map<number, TimerEntry>();
    const state = { next: 0, prefix: `copilot-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`, entries } as TimerState;
    let registeringSystemTimer = false;
    const schedule = (interval: boolean, callback: TimerHandler, delay = 0, ...args: unknown[]): number => {
        if (typeof callback !== 'function') throw new TypeError('Timer callback must be a function');
        // Outside a sandbox, SYS_Timer can call our replaced global timer itself.
        // Use the captured native function for that inner registration to avoid recursion.
        if (registeringSystemTimer) {
            const native = interval ? nativeInterval : nativeTimeout;
            if (typeof native !== 'function') throw new Error('Native timer is unavailable');
            return native(callback, Number(delay), ...args);
        }
        // Negative handles cannot collide with pre-bootstrap browser timer IDs.
        const handle = --state.next;
        const entry: TimerEntry = { id: `${state.prefix}-${-handle}`, interval };
        entries.set(handle, entry);
        const invoke = () => {
            if (!entries.has(handle)) return;
            if (!interval) entries.delete(handle);
            callback.apply(host, args);
        };
        let registered = false;
        try {
            registeringSystemTimer = true;
            registered = interval ? timerApi.setIntervalTimer(entry.id, Number(delay), invoke)
                : timerApi.setTimeoutTimer(entry.id, Number(delay), invoke);
        } catch { /* Older editors can reject a system timer; retain a native fallback. */ }
        finally { registeringSystemTimer = false; }
        if (!registered) {
            const native = interval ? nativeInterval : nativeTimeout;
            if (typeof native !== 'function') {
                entries.delete(handle);
                throw new Error('Neither EasyEDA nor native timers are available');
            }
            try { entry.nativeHandle = native(invoke, Number(delay)); }
            catch (error) { entries.delete(handle); throw error; }
        }
        return handle;
    };
    const clear = (handle?: number) => {
        if (handle === undefined) return;
        const entry = entries.get(Number(handle));
        if (!entry) {
            // Allow callers to cancel browser handles obtained before bootstrap.
            if (Number(handle) >= 0) nativeClearTimeout?.(handle);
            return;
        }
        entries.delete(Number(handle));
        if (entry.nativeHandle !== undefined) {
            (entry.interval ? nativeClearInterval : nativeClearTimeout)?.(entry.nativeHandle);
        } else {
            if (entry.interval) timerApi.clearIntervalTimer(entry.id);
            else timerApi.clearTimeoutTimer(entry.id);
        }
    };
    state.timeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => schedule(false, callback, delay, ...args)) as typeof setTimeout;
    state.interval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => schedule(true, callback, delay, ...args)) as typeof setInterval;
    state.clear = clear;
    api.__copilotRuntimeTimers = state;
    installTimers(state);
})();
