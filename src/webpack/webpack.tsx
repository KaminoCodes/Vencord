/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { proxyLazy } from "@utils/lazy";
import { LazyComponent } from "@utils/lazyReact";
import { Logger } from "@utils/Logger";
import { canonicalizeMatch } from "@utils/patches";
import { proxyInner, proxyInnerValue } from "@utils/proxyInner";
import { NoopComponent } from "@utils/react";
import type { WebpackInstance } from "discord-types/other";

import { traceFunction } from "../debug/Tracer";

const logger = new Logger("Webpack");

export let _resolveReady: () => void;
/**
 * Fired once a gateway connection to Discord has been established.
 * This indicates that the core webpack modules have been initialised
 */
export const onceReady = new Promise<void>(r => _resolveReady = r);

export let wreq: WebpackInstance;
export let cache: WebpackInstance["c"];

export type FilterFn = (mod: any) => boolean;

export const filters = {
    byProps: (...props: string[]): FilterFn => {
        const filter = props.length === 1
            ? m => m?.[props[0]] !== void 0
            : m => props.every(p => m?.[p] !== void 0);

        // @ts-ignore
        filter.$$vencordProps = props;
        return filter;
    },

    byCode: (...code: string[]): FilterFn => {
        const filter = m => {
            if (typeof m !== "function") return false;
            const s = Function.prototype.toString.call(m);
            for (const c of code) {
                if (!s.includes(c)) return false;
            }
            return true;
        };

        filter.$$vencordProps = code;
        return filter;
    },

    byStoreName: (name: string): FilterFn => {
        const filter = m => m?.constructor?.displayName === name;

        filter.$$vencordProps = [name];
        return filter;
    },

    componentByCode: (...code: string[]): FilterFn => {
        const filter = filters.byCode(...code);
        const wrapper = m => {
            if (filter(m)) return true;
            if (!m?.$$typeof) return false;
            if (m?.type && m.type.render) return filter(m.type.render); // memo + forwardRef
            if (m?.type) return filter(m.type); // memos
            if (m?.render) return filter(m.render); // forwardRefs
            return false;
        };

        wrapper.$$vencordProps = code;
        return wrapper;
    }
};

export type ModCallbackFn = (mod: any) => void;
export type ModCallbackFnWithId = (mod: any, id: string) => void;

export const waitForSubscriptions = new Map<FilterFn, ModCallbackFn>();
export const listeners = new Set<ModCallbackFnWithId>();

export function _initWebpack(instance: typeof window.webpackChunkdiscord_app) {
    if (cache !== void 0) throw "no.";

    instance.push([[Symbol("Vencord")], {}, r => wreq = r]);
    instance.pop();
    if (!wreq) return false;

    cache = wreq.c;
    return true;
}

let devToolsOpen = false;
if (IS_DEV && IS_DISCORD_DESKTOP) {
    // At this point in time, DiscordNative has not been exposed yet, so setImmediate is needed
    setTimeout(() => {
        DiscordNative/* just to make sure */?.window.setDevtoolsCallbacks(() => devToolsOpen = true, () => devToolsOpen = false);
    }, 0);
}

export const webpackSearchHistory = [] as Array<["waitFor" | "proxyInnerWaitFor" | "findComponent" | "findExportedComponent" | "findComponentByCode" | "findByProps" | "findByCode" | "findStore" | "extractAndLoadChunks" | "proxyLazyWebpack" | "LazyComponentWebpack", any[]]>;

function handleModuleNotFound(method: string, ...filter: unknown[]) {
    const err = new Error(`webpack.${method} found no module`);
    logger.error(err, "Filter:", filter);

    // Strict behaviour in DevBuilds to fail early and make sure the issue is found
    if (IS_DEV && !devToolsOpen)
        throw err;
}

/**
 * Find the first already required module that matches the filter.
 * @param filter A function that takes a module and returns a boolean
 * @returns The found module or null
 */
export const find = traceFunction("find", function find(filter: FilterFn, { isIndirect = false }: { isIndirect?: boolean; } = {}) {
    if (typeof filter !== "function")
        throw new Error("Invalid filter. Expected a function got " + typeof filter);

    for (const key in cache) {
        const mod = cache[key];
        if (!mod?.exports) continue;

        if (filter(mod.exports)) {
            return mod.exports;
        }

        if (mod.exports.default && filter(mod.exports.default)) {
            return mod.exports.default;
        }
    }

    if (!isIndirect) {
        handleModuleNotFound("find", filter);
    }

    return null;
});

/**
 * Wait for the first module that matches the provided filter to be required,
 * then call the callback with the module as the first argument.
 *
 * If the module is already required, the callback will be called immediately.
 * @param filter A function that takes a module and returns a boolean
 * @param callback A function that takes the found module as its first argument
 */
export function waitFor(filter: FilterFn, callback: ModCallbackFn, { isIndirect = false }: { isIndirect?: boolean; } = {}) {
    if (typeof filter !== "function")
        throw new Error("Invalid filter. Expected a function got " + typeof filter);
    if (typeof callback !== "function")
        throw new Error("Invalid callback. Expected a function got " + typeof callback);

    if (IS_DEV && !isIndirect) webpackSearchHistory.push(["waitFor", [filter]]);

    if (cache != null) {
        const existing = find(filter, { isIndirect: true });
        if (existing) return callback(existing);
    }

    waitForSubscriptions.set(filter, callback);
}

/**
 * Wait for the first module that matches the provided filter to be required,
 * then call the callback with the module as the first argument.
 *
 * If the module is already required, the callback will be called immediately.
 *
 * The callback must return a value that will be used as the proxy inner value.
 *
 * If no callback is specified, the default callback will assign the proxy inner value to all the module
 * @param filter A function that takes a module and returns a boolean
 * @param callback A function that takes the found module as its first argument and returns to use as the proxy inner value
 * @returns A proxy that has the callback return value as its true value, or the callback return value if the callback was called when the function was called
 */
export function proxyInnerWaitFor<T = any>(filter: FilterFn, callback: (mod: any) => any = m => m, { isIndirect = false }: { isIndirect?: boolean; } = {}) {
    if (typeof filter !== "function")
        throw new Error("Invalid filter. Expected a function got " + typeof filter);
    if (typeof callback !== "function")
        throw new Error("Invalid callback. Expected a function got " + typeof callback);

    if (IS_DEV && !isIndirect) webpackSearchHistory.push(["proxyInnerWaitFor", [filter]]);

    const [proxy, setInnerValue] = proxyInner<T>();
    waitFor(filter, mod => setInnerValue(callback(mod)), { isIndirect: true });

    if (proxy[proxyInnerValue] != null) return proxy[proxyInnerValue];

    return proxy;
}

/**
 * Find the first component that matches the filter.
 * @param filter A function that takes a module and returns a boolean
 * @param parse A function that takes the found component as its first argument and returns a component. Useful if you want to wrap the found component in something. Defaults to the original component
 * @returns The component if found, or a noop component
 */
export function findComponent<T extends object = any>(filter: FilterFn, parse: (component: any) => React.ComponentType<T> = m => m, { isIndirect = false }: { isIndirect?: boolean; } = {}) {
    if (typeof filter !== "function")
        throw new Error("Invalid filter. Expected a function got " + typeof filter);
    if (typeof parse !== "function")
        throw new Error("Invalid component parse. Expected a function got " + typeof parse);

    if (IS_DEV && !isIndirect) webpackSearchHistory.push(["findComponent", [filter]]);

    let InnerComponent = NoopComponent as React.ComponentType<T>;

    const WrapperComponent = (props: T) => {
        return <InnerComponent {...props} />;
    };

    WrapperComponent.$$vencordGetter = () => InnerComponent;

    waitFor(filter, (v: any) => {
        const parsedComponent = parse(v);
        InnerComponent = parsedComponent;
        Object.assign(InnerComponent, parsedComponent);
    }, { isIndirect: true });

    if (InnerComponent !== NoopComponent) return InnerComponent;

    return WrapperComponent;
}

/**
 * Find the first component that is exported by the first prop name.
 *
 * @example findExportedComponent("FriendRow")
 * @example findExportedComponent("FriendRow", "Friend", FriendRow => React.memo(FriendRow))
 *
 * @param props A list of prop names to search the exports for
 * @param parse A function that takes the found component as its first argument and returns a component. Useful if you want to wrap the found component in something. Defaults to the original component
 * @returns The component if found, or a noop component
 */
export function findExportedComponent<T extends object = any>(...props: string[] | [...string[], (component: any) => React.ComponentType<T>]) {
    const parse = (typeof props.at(-1) === "function" ? props.pop() : m => m) as (component: any) => React.ComponentType<T>;
    const newProps = props as string[];

    if (IS_DEV) webpackSearchHistory.push(["findExportedComponent", props]);

    let InnerComponent = NoopComponent as React.ComponentType<T>;

    const WrapperComponent = (props: T) => {
        return <InnerComponent {...props} />;
    };

    WrapperComponent.$$vencordGetter = () => InnerComponent;

    waitFor(filters.byProps(...newProps), (v: any) => {
        const parsedComponent = parse(v[newProps[0]]);
        InnerComponent = parsedComponent;
        Object.assign(InnerComponent, parsedComponent);
    }, { isIndirect: true });

    if (InnerComponent !== NoopComponent) return InnerComponent;

    return WrapperComponent as React.ComponentType<T>;
}

/**
 * Find the first component that includes all the given code.
 *
 * @example findComponentByCode(".Messages.USER_SETTINGS_PROFILE_COLOR_SELECT_COLOR")
 * @example findComponentByCode(".Messages.USER_SETTINGS_PROFILE_COLOR_SELECT_COLOR", ".BACKGROUND_PRIMARY)", ColorPicker => React.memo(ColorPicker))
 *
 * @param code A list of code to search each export for
 * @param parse A function that takes the found component as its first argument and returns a component. Useful if you want to wrap the found component in something. Defaults to the original component
 * @returns The component if found, or a noop component
 */
export function findComponentByCode<T extends object = any>(...code: string[] | [...string[], (component: any) => React.ComponentType<T>]) {
    const parse = (typeof code.at(-1) === "function" ? code.pop() : m => m) as (component: any) => React.ComponentType<T>;
    const newCode = code as string[];

    if (IS_DEV) webpackSearchHistory.push(["findComponentByCode", code]);

    return findComponent<T>(filters.componentByCode(...newCode), parse, { isIndirect: true });
}

/**
 * Find the first module or default export that includes all the given props
 *
 * @param props A list of props to search the exports for
 */
export function findByProps<T = any>(...props: string[]) {
    if (IS_DEV) webpackSearchHistory.push(["findByProps", props]);

    return proxyInnerWaitFor<T>(filters.byProps(...props), m => m, { isIndirect: true });
}

/**
 * Find the first export that includes all the given code
 *
 * @param code A list of code to search each export for
 */
export function findByCode<T = any>(...code: string[]) {
    if (IS_DEV) webpackSearchHistory.push(["findByCode", code]);

    return proxyInnerWaitFor<T>(filters.byCode(...code), m => m, { isIndirect: true });
}

/**
 * Find a store by its name
 *
 * @param name The store name
 */
export function findStore<T = any>(name: string) {
    if (IS_DEV) webpackSearchHistory.push(["findStore", [name]]);

    return proxyInnerWaitFor<T>(filters.byStoreName(name), m => m, { isIndirect: true });
}

export function findAll(filter: FilterFn) {
    if (typeof filter !== "function")
        throw new Error("Invalid filter. Expected a function got " + typeof filter);

    const ret = [] as any[];
    for (const key in cache) {
        const mod = cache[key];
        if (!mod?.exports) continue;

        if (filter(mod.exports))
            ret.push(mod.exports);

        if (mod.exports.default && filter(mod.exports.default))
            ret.push(mod.exports.default);
    }

    return ret;
}

/**
 * Same as {@link find} but in bulk
 * @param filterFns Array of filters. Please note that this array will be modified in place, so if you still
 *                need it afterwards, pass a copy.
 * @returns Array of results in the same order as the passed filters
 */
export const findBulk = traceFunction("findBulk", function findBulk(...filterFns: FilterFn[]) {
    if (!Array.isArray(filterFns))
        throw new Error("Invalid filters. Expected function[] got " + typeof filterFns);

    const { length } = filterFns;

    if (length === 0)
        throw new Error("Expected at least two filters.");

    if (length === 1) {
        if (IS_DEV) {
            throw new Error("bulk called with only one filter. Use find");
        }
        return find(filterFns[0]);
    }

    let found = 0;
    const results = Array(length);

    outer:
    for (const key in cache) {
        const mod = cache[key];
        if (!mod?.exports) continue;

        for (let j = 0; j < length; j++) {
            const filter = filterFns[j];

            if (filter(mod.exports)) {
                results[j] = mod.exports;
                filterFns.splice(j--, 1);
                if (++found === length) break outer;
                break;
            }

            if (mod.exports.default && filter(mod.exports.default)) {
                results[j] = mod.exports.default;
                filterFns.splice(j--, 1);
                if (++found === length) break outer;
                break;
            }
        }
    }

    if (found !== length) {
        const err = new Error(`Got ${length} filters, but only found ${found} modules!`);
        if (IS_DEV) {
            if (!devToolsOpen)
                // Strict behaviour in DevBuilds to fail early and make sure the issue is found
                throw err;
        } else {
            logger.warn(err);
        }
    }

    return results;
});

/**
 * Find the id of the first module factory that includes all the given code
 * @returns string or null
 */
export const findModuleId = traceFunction("findModuleId", function findModuleId(...code: string[]) {
    outer:
    for (const id in wreq.m) {
        const str = wreq.m[id].toString();

        for (const c of code) {
            if (!str.includes(c)) continue outer;
        }
        return id;
    }

    const err = new Error("Didn't find module with code(s):\n" + code.join("\n"));
    if (IS_DEV) {
        if (!devToolsOpen)
            // Strict behaviour in DevBuilds to fail early and make sure the issue is found
            throw err;
    } else {
        logger.warn(err);
    }

    return null;
});

/**
 * Find the first module factory that includes all the given code
 * @returns The module factory or null
 */
export function findModuleFactory(...code: string[]) {
    const id = findModuleId(...code);
    if (!id) return null;

    return wreq.m[id];
}

/**
 * This is just a wrapper around {@link proxyLazy} to make our reporter test for your webpack finds.
 *
 * Wraps the result of {@link makeLazy} in a Proxy you can consume as if it wasn't lazy.
 * On first property access, the lazy is evaluated
 * @param factory lazy factory
 * @param attempts how many times to try to evaluate the lazy before giving up
 * @returns Proxy
 */
export function proxyLazyWebpack<T = any>(factory: () => any, attempts?: number) {
    if (IS_DEV) webpackSearchHistory.push(["proxyLazyWebpack", [factory]]);

    return proxyLazy<T>(factory, attempts);
}

/**
 * This is just a wrapper around {@link LazyComponent} to make our reporter test for your webpack finds.
 *
 * A lazy component. The factory method is called on first render.
 * @param factory Function returning a Component
 * @param attempts How many times to try to get the component before giving up
 * @returns Result of factory function
 */
export function LazyComponentWebpack<T extends object = any>(factory: () => any, attempts?: number) {
    if (IS_DEV) webpackSearchHistory.push(["LazyComponentWebpack", [factory]]);

    return LazyComponent<T>(factory, attempts);
}

/**
 * Extract and load chunks using their entry point
 * @param code An array of all the code the module factory containing the entry point (as of using it to load chunks) must include
 * @param matcher A RegExp that returns the entry point id as the first capture group. Defaults to a matcher that captures the first entry point found in the module factory
 */
export async function extractAndLoadChunks(code: string[], matcher: RegExp = /\.el\("(.+?)"\)(?<=(\i)\.el.+?)\.then\(\2\.bind\(\2,"\1"\)\)/) {
    const module = findModuleFactory(...code);
    if (!module) {
        const err = new Error("extractAndLoadChunks: Couldn't find module factory");
        logger.warn(err, "Code:", code, "Matcher:", matcher);

        return;
    }

    const match = module.toString().match(canonicalizeMatch(matcher));
    if (!match) {
        const err = new Error("extractAndLoadChunks: Couldn't find entry point id in module factory code");
        logger.warn(err, "Code:", code, "Matcher:", matcher);

        // Strict behaviour in DevBuilds to fail early and make sure the issue is found
        if (IS_DEV && !devToolsOpen)
            throw err;

        return;
    }

    const [, id] = match;
    if (!id || !Number(id)) {
        const err = new Error("extractAndLoadChunks: Matcher didn't return a capturing group with the entry point, or the entry point returned wasn't a number");
        logger.warn(err, "Code:", code, "Matcher:", matcher);

        // Strict behaviour in DevBuilds to fail early and make sure the issue is found
        if (IS_DEV && !devToolsOpen)
            throw err;

        return;
    }

    await (wreq as any).el(id);
    return wreq(id as any);
}

/**
 * This is just a wrapper around {@link extractAndLoadChunks} to make our reporter test for your webpack finds.
 *
 * Extract and load chunks using their entry point
 * @param code An array of all the code the module factory containing the entry point (as of using it to load chunks) must include
 * @param matcher A RegExp that returns the entry point id as the first capture group. Defaults to a matcher that captures the first entry point found in the module factory
 * @returns A function that loads the chunks on first call
 */
export function extractAndLoadChunksLazy(code: string[], matcher: RegExp = /\.el\("(.+?)"\)(?<=(\i)\.el.+?)\.then\(\2\.bind\(\2,"\1"\)\)/) {
    if (IS_DEV) webpackSearchHistory.push(["extractAndLoadChunks", [code, matcher]]);

    return () => extractAndLoadChunks(code, matcher);
}

/**
 * Search modules by keyword. This searches the factory methods,
 * meaning you can search all sorts of things, displayName, methodName, strings somewhere in the code, etc
 * @param filters One or more strings or regexes
 * @returns Mapping of found modules
 */
export function search(...filters: Array<string | RegExp>) {
    const results = {} as Record<number, Function>;
    const factories = wreq.m;
    outer:
    for (const id in factories) {
        const factory = factories[id];
        const str: string = factory.toString();
        for (const filter of filters) {
            if (typeof filter === "string" && !str.includes(filter)) continue outer;
            if (filter instanceof RegExp && !filter.test(str)) continue outer;
        }
        results[id] = factory;
    }

    return results;
}

/**
 * Extract a specific module by id into its own Source File. This has no effect on
 * the code, it is only useful to be able to look at a specific module without having
 * to view a massive file. extract then returns the extracted module so you can jump to it.
 * As mentioned above, note that this extracted module is not actually used,
 * so putting breakpoints or similar will have no effect.
 * @param id The id of the module to extract
 */
export function extract(id: string | number) {
    const mod = wreq.m[id] as Function;
    if (!mod) return null;

    const code = `
// [EXTRACTED] WebpackModule${id}
// WARNING: This module was extracted to be more easily readable.
//          This module is NOT ACTUALLY USED! This means putting breakpoints will have NO EFFECT!!

0,${mod.toString()}
//# sourceURL=ExtractedWebpackModule${id}
`;
    const extracted = (0, eval)(code);
    return extracted as Function;
}
