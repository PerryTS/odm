import type { Document } from '@perryts/mongodb';

export type IndexDirection = 1 | -1 | '2d' | '2dsphere' | 'text' | 'hashed';

export interface IndexSpec {
    keys: Record<string, IndexDirection>;
    unique?: boolean;
    sparse?: boolean;
    expireAfterSeconds?: number;
    partialFilterExpression?: Document;
    name?: string;
    collation?: Document;
}

export type HookEvent = 'insert' | 'update' | 'delete';

export interface HookContext {
    event: HookEvent;
    modelName: string;
}

export type BeforeInsertHook<T> = (doc: T, ctx: HookContext) => void | Promise<void>;
export type AfterInsertHook<T> = (doc: T, ctx: HookContext) => void | Promise<void>;
export type BeforeUpdateHook = (filter: Document, update: Document, ctx: HookContext) => void | Promise<void>;
export type AfterUpdateHook = (filter: Document, update: Document, ctx: HookContext) => void | Promise<void>;
export type BeforeDeleteHook = (filter: Document, ctx: HookContext) => void | Promise<void>;
export type AfterDeleteHook = (filter: Document, ctx: HookContext) => void | Promise<void>;
