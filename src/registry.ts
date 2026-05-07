// Process-global registry of initialized models, keyed by collection
// name. populate() uses this to look up the target collection at
// query-build time without requiring the user to thread Model
// references everywhere.
//
// Models register themselves on initModels() and never unregister —
// process lifetime matches the binary's lifetime under Perry AOT.

import type { Model } from './model';

const REGISTRY: Map<string, Model<string, never>> = new Map();

export function registerModel(name: string, model: Model<string, never>): void {
    REGISTRY.set(name, model);
}

export function getModel(name: string): Model<string, never> | undefined {
    return REGISTRY.get(name);
}

export function clearRegistry(): void {
    REGISTRY.clear();
}
