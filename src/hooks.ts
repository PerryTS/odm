import type { z } from 'zod';
import type { Model } from './model';
import type {
    BeforeInsertHook,
    AfterInsertHook,
    BeforeUpdateHook,
    AfterUpdateHook,
    BeforeDeleteHook,
    AfterDeleteHook,
} from './types';

/**
 * Register a hook that runs *before* a write reaches MongoDB.
 *
 * For 'insert', the hook receives the input document (Zod *input*
 * type — what the user passed) and may mutate it in place. Mongoose
 * `pre('save')` for new docs maps here; for updates use 'update'.
 *
 * For 'update' / 'delete', the hook receives (filter, update?) and
 * is read-only by convention — mutating the filter is supported but
 * mutating the update document is the more common case.
 */
export function before<TName extends string, TSchema extends z.ZodObject<z.ZodRawShape>>(
    model: Model<TName, TSchema>,
    event: 'insert',
    fn: BeforeInsertHook<z.input<TSchema>>,
): void;
export function before<TName extends string, TSchema extends z.ZodObject<z.ZodRawShape>>(
    model: Model<TName, TSchema>,
    event: 'update',
    fn: BeforeUpdateHook,
): void;
export function before<TName extends string, TSchema extends z.ZodObject<z.ZodRawShape>>(
    model: Model<TName, TSchema>,
    event: 'delete',
    fn: BeforeDeleteHook,
): void;
export function before<TName extends string, TSchema extends z.ZodObject<z.ZodRawShape>>(
    model: Model<TName, TSchema>,
    event: 'insert' | 'update' | 'delete',
    fn: BeforeInsertHook<z.input<TSchema>> | BeforeUpdateHook | BeforeDeleteHook,
): void {
    if (event === 'insert') {
        model._addBeforeInsert(fn as BeforeInsertHook<z.input<TSchema>>);
    } else if (event === 'update') {
        model._addBeforeUpdate(fn as BeforeUpdateHook);
    } else {
        model._addBeforeDelete(fn as BeforeDeleteHook);
    }
}

export function after<TName extends string, TSchema extends z.ZodObject<z.ZodRawShape>>(
    model: Model<TName, TSchema>,
    event: 'insert',
    fn: AfterInsertHook<z.output<TSchema> & { _id: import('@perryts/mongodb').ObjectId }>,
): void;
export function after<TName extends string, TSchema extends z.ZodObject<z.ZodRawShape>>(
    model: Model<TName, TSchema>,
    event: 'update',
    fn: AfterUpdateHook,
): void;
export function after<TName extends string, TSchema extends z.ZodObject<z.ZodRawShape>>(
    model: Model<TName, TSchema>,
    event: 'delete',
    fn: AfterDeleteHook,
): void;
export function after<TName extends string, TSchema extends z.ZodObject<z.ZodRawShape>>(
    model: Model<TName, TSchema>,
    event: 'insert' | 'update' | 'delete',
    fn:
        | AfterInsertHook<z.output<TSchema> & { _id: import('@perryts/mongodb').ObjectId }>
        | AfterUpdateHook
        | AfterDeleteHook,
): void {
    if (event === 'insert') {
        model._addAfterInsert(
            fn as AfterInsertHook<z.output<TSchema> & { _id: import('@perryts/mongodb').ObjectId }>,
        );
    } else if (event === 'update') {
        model._addAfterUpdate(fn as AfterUpdateHook);
    } else {
        model._addAfterDelete(fn as AfterDeleteHook);
    }
}
