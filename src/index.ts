// Public barrel for @perryts/odm.
//
// Surface — anything not re-exported here is an implementation
// detail subject to change without a major bump.

export { defineModel, Model } from './model';
export type { ModelOptions } from './model';

export { ref, getRefTarget } from './ref';
export type { Ref } from './ref';

export { before, after } from './hooks';

export { initModels } from './init';

export { PopulateBuilder } from './populate';

export { getModel, clearRegistry } from './registry';

export type {
    IndexSpec,
    IndexDirection,
    HookEvent,
    HookContext,
    BeforeInsertHook,
    AfterInsertHook,
    BeforeUpdateHook,
    AfterUpdateHook,
    BeforeDeleteHook,
    AfterDeleteHook,
} from './types';

// Re-export ObjectId so callers don't need a second import for the
// most common case.
export { ObjectId } from '@perryts/mongodb';
