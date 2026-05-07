import { z } from 'zod';
import {
    Collection,
    ObjectId,
    type Db,
    type Document,
    type FindOptions,
    type CountOptions,
    type DeleteOptions,
    type UpdateOptions,
    type InsertOneOptions,
    type InsertManyOptions,
    type AggregateOptions,
    type AggregationCursor,
} from '@perryts/mongodb';

import type {
    IndexSpec,
    HookContext,
    HookEvent,
    BeforeInsertHook,
    AfterInsertHook,
    BeforeUpdateHook,
    AfterUpdateHook,
    BeforeDeleteHook,
    AfterDeleteHook,
} from './types';
import { registerModel } from './registry';
import { PopulateBuilder } from './populate';

export interface ModelOptions {
    indexes?: IndexSpec[];
    /**
     * If true, every insert sets `createdAt` + `updatedAt`, and every
     * update $set's `updatedAt`. Both fields must be declared in the
     * Zod schema (typically `z.date().optional()`); the hook fills
     * them in if missing.
     */
    timestamps?: boolean;
}

type WithId<T> = T & { _id: ObjectId };

/**
 * Result of `defineModel`. Holds:
 * - the Zod schema for parse-on-write validation
 * - declarative index specs (applied by initModels)
 * - registered hooks (mutated via before/after helpers)
 * - the bound MongoDB Collection (set by initModels — methods throw
 *   before that)
 */
export class Model<TName extends string, TSchema extends z.ZodObject<z.ZodRawShape>> {
    readonly name: TName;
    readonly schema: TSchema;
    readonly indexes: ReadonlyArray<IndexSpec>;
    readonly timestamps: boolean;

    private _collection: Collection<WithId<z.output<TSchema>>> | null = null;
    private _db: Db | null = null;

    private readonly beforeInsertHooks: BeforeInsertHook<z.input<TSchema>>[] = [];
    private readonly afterInsertHooks: AfterInsertHook<WithId<z.output<TSchema>>>[] = [];
    private readonly beforeUpdateHooks: BeforeUpdateHook[] = [];
    private readonly afterUpdateHooks: AfterUpdateHook[] = [];
    private readonly beforeDeleteHooks: BeforeDeleteHook[] = [];
    private readonly afterDeleteHooks: AfterDeleteHook[] = [];

    constructor(name: TName, schema: TSchema, options: ModelOptions = {}) {
        this.name = name;
        this.schema = schema;
        this.indexes = options.indexes ?? [];
        this.timestamps = options.timestamps === true;
    }

    /** @internal — called by initModels(). */
    _bind(db: Db): void {
        this._db = db;
        this._collection = db.collection<WithId<z.output<TSchema>>>(this.name);
    }

    private get database(): Db {
        if (this._db == null) {
            throw new Error(
                `Model "${this.name}" is not initialized. Call initModels(db, [...]) before use.`,
            );
        }
        return this._db;
    }

    /** @internal */
    get collection(): Collection<WithId<z.output<TSchema>>> {
        if (this._collection == null) {
            throw new Error(
                `Model "${this.name}" is not initialized. Call initModels(db, [...]) before use.`,
            );
        }
        return this._collection;
    }

    /** @internal — called by `before(...)`. */
    _addBeforeInsert(fn: BeforeInsertHook<z.input<TSchema>>): void {
        this.beforeInsertHooks.push(fn);
    }
    _addAfterInsert(fn: AfterInsertHook<WithId<z.output<TSchema>>>): void {
        this.afterInsertHooks.push(fn);
    }
    _addBeforeUpdate(fn: BeforeUpdateHook): void {
        this.beforeUpdateHooks.push(fn);
    }
    _addAfterUpdate(fn: AfterUpdateHook): void {
        this.afterUpdateHooks.push(fn);
    }
    _addBeforeDelete(fn: BeforeDeleteHook): void {
        this.beforeDeleteHooks.push(fn);
    }
    _addAfterDelete(fn: AfterDeleteHook): void {
        this.afterDeleteHooks.push(fn);
    }

    private hookCtx(event: HookEvent): HookContext {
        return { event, modelName: this.name };
    }

    // ─── Writes ─────────────────────────────────────────────────────────────

    async insert(input: z.input<TSchema>, options: InsertOneOptions = {}): Promise<WithId<z.output<TSchema>>> {
        const ctx = this.hookCtx('insert');
        for (let i = 0; i < this.beforeInsertHooks.length; i++) {
            await this.beforeInsertHooks[i](input, ctx);
        }
        const parsed = this.schema.parse(input) as z.output<TSchema>;
        if (this.timestamps) {
            const now = new Date();
            (parsed as Document).createdAt ??= now;
            (parsed as Document).updatedAt ??= now;
        }
        const doc = parsed as WithId<z.output<TSchema>>;
        const res = await this.collection.insertOne(doc, options);
        if (doc._id == null) {
            doc._id = res.insertedId as ObjectId;
        }
        for (let i = 0; i < this.afterInsertHooks.length; i++) {
            await this.afterInsertHooks[i](doc, ctx);
        }
        return doc;
    }

    async insertMany(
        inputs: z.input<TSchema>[],
        options: InsertManyOptions = {},
    ): Promise<WithId<z.output<TSchema>>[]> {
        const ctx = this.hookCtx('insert');
        const docs: WithId<z.output<TSchema>>[] = [];
        for (let i = 0; i < inputs.length; i++) {
            const input = inputs[i];
            for (let j = 0; j < this.beforeInsertHooks.length; j++) {
                await this.beforeInsertHooks[j](input, ctx);
            }
            const parsed = this.schema.parse(input) as z.output<TSchema>;
            if (this.timestamps) {
                const now = new Date();
                (parsed as Document).createdAt ??= now;
                (parsed as Document).updatedAt ??= now;
            }
            docs.push(parsed as WithId<z.output<TSchema>>);
        }
        const res = await this.collection.insertMany(docs, options);
        for (let i = 0; i < docs.length; i++) {
            if (docs[i]._id == null) {
                docs[i]._id = res.insertedIds[i] as ObjectId;
            }
        }
        for (let i = 0; i < this.afterInsertHooks.length; i++) {
            for (let j = 0; j < docs.length; j++) {
                await this.afterInsertHooks[i](docs[j], ctx);
            }
        }
        return docs;
    }

    async updateOne(filter: Document, update: Document, options: UpdateOptions = {}): Promise<number> {
        const ctx = this.hookCtx('update');
        const stamped = this.applyTimestamps(update);
        for (let i = 0; i < this.beforeUpdateHooks.length; i++) {
            await this.beforeUpdateHooks[i](filter, stamped, ctx);
        }
        const res = await this.collection.updateOne(filter, stamped, options);
        for (let i = 0; i < this.afterUpdateHooks.length; i++) {
            await this.afterUpdateHooks[i](filter, stamped, ctx);
        }
        return res.modifiedCount;
    }

    async updateMany(filter: Document, update: Document, options: UpdateOptions = {}): Promise<number> {
        const ctx = this.hookCtx('update');
        const stamped = this.applyTimestamps(update);
        for (let i = 0; i < this.beforeUpdateHooks.length; i++) {
            await this.beforeUpdateHooks[i](filter, stamped, ctx);
        }
        const res = await this.collection.updateMany(filter, stamped, options);
        for (let i = 0; i < this.afterUpdateHooks.length; i++) {
            await this.afterUpdateHooks[i](filter, stamped, ctx);
        }
        return res.modifiedCount;
    }

    async deleteOne(filter: Document, options: DeleteOptions = {}): Promise<number> {
        const ctx = this.hookCtx('delete');
        for (let i = 0; i < this.beforeDeleteHooks.length; i++) {
            await this.beforeDeleteHooks[i](filter, ctx);
        }
        const res = await this.collection.deleteOne(filter, options);
        for (let i = 0; i < this.afterDeleteHooks.length; i++) {
            await this.afterDeleteHooks[i](filter, ctx);
        }
        return res.deletedCount;
    }

    async deleteMany(filter: Document, options: DeleteOptions = {}): Promise<number> {
        const ctx = this.hookCtx('delete');
        for (let i = 0; i < this.beforeDeleteHooks.length; i++) {
            await this.beforeDeleteHooks[i](filter, ctx);
        }
        const res = await this.collection.deleteMany(filter, options);
        for (let i = 0; i < this.afterDeleteHooks.length; i++) {
            await this.afterDeleteHooks[i](filter, ctx);
        }
        return res.deletedCount;
    }

    /**
     * Atomic find-and-update. Maps to MongoDB's `findAndModify`.
     *
     * `returnDocument` defaults to 'after' — the doc returned reflects
     * the update. This matches modern Mongoose behavior; callers
     * porting from pre-Mongoose-6 code that relied on the old `new:
     * false` default must pass `returnDocument: 'before'` explicitly.
     */
    async findOneAndUpdate(
        filter: Document,
        update: Document,
        options: {
            sort?: Document;
            upsert?: boolean;
            returnDocument?: 'before' | 'after';
            projection?: Document;
            arrayFilters?: Document[];
            collation?: Document;
            bypassDocumentValidation?: boolean;
        } = {},
    ): Promise<WithId<z.output<TSchema>> | null> {
        const ctx = this.hookCtx('update');
        const stamped = this.applyTimestamps(update);
        for (let i = 0; i < this.beforeUpdateHooks.length; i++) {
            await this.beforeUpdateHooks[i](filter, stamped, ctx);
        }
        const cmd: Document = {
            findAndModify: this.name,
            query: filter,
            update: stamped,
            new: options.returnDocument !== 'before',
        };
        if (options.sort !== undefined) cmd.sort = options.sort;
        if (options.upsert !== undefined) cmd.upsert = options.upsert;
        if (options.projection !== undefined) cmd.fields = options.projection;
        if (options.arrayFilters !== undefined) cmd.arrayFilters = options.arrayFilters;
        if (options.collation !== undefined) cmd.collation = options.collation;
        if (options.bypassDocumentValidation !== undefined) {
            cmd.bypassDocumentValidation = options.bypassDocumentValidation;
        }
        const reply = await this.database.command(cmd);
        for (let i = 0; i < this.afterUpdateHooks.length; i++) {
            await this.afterUpdateHooks[i](filter, stamped, ctx);
        }
        const value = reply.value;
        return value == null ? null : (value as WithId<z.output<TSchema>>);
    }

    /** Atomic find-and-delete. Returns the deleted doc, or null. */
    async findOneAndDelete(
        filter: Document,
        options: { sort?: Document; projection?: Document; collation?: Document } = {},
    ): Promise<WithId<z.output<TSchema>> | null> {
        const ctx = this.hookCtx('delete');
        for (let i = 0; i < this.beforeDeleteHooks.length; i++) {
            await this.beforeDeleteHooks[i](filter, ctx);
        }
        const cmd: Document = {
            findAndModify: this.name,
            query: filter,
            remove: true,
        };
        if (options.sort !== undefined) cmd.sort = options.sort;
        if (options.projection !== undefined) cmd.fields = options.projection;
        if (options.collation !== undefined) cmd.collation = options.collation;
        const reply = await this.database.command(cmd);
        for (let i = 0; i < this.afterDeleteHooks.length; i++) {
            await this.afterDeleteHooks[i](filter, ctx);
        }
        const value = reply.value;
        return value == null ? null : (value as WithId<z.output<TSchema>>);
    }

    // ─── Reads ──────────────────────────────────────────────────────────────

    findOne(filter: Document = {}, options: FindOptions = {}): Promise<WithId<z.output<TSchema>> | null> {
        return this.collection.findOne(filter, options);
    }

    findById(id: ObjectId | string, options: FindOptions = {}): Promise<WithId<z.output<TSchema>> | null> {
        const oid = typeof id === 'string' ? new ObjectId(id) : id;
        return this.collection.findOne({ _id: oid }, options);
    }

    /**
     * Returns a builder. Call `.exec()` for the array, or chain
     * `.populate(field)` to lower into an aggregation with `$lookup`.
     * Mongoose users: this is the equivalent of `Model.find().populate(...)`.
     */
    find(filter: Document = {}, options: FindOptions = {}): PopulateBuilder<WithId<z.output<TSchema>>, TSchema> {
        return new PopulateBuilder<WithId<z.output<TSchema>>, TSchema>(this, filter, options);
    }

    countDocuments(filter: Document = {}, options: CountOptions = {}): Promise<number> {
        return this.collection.countDocuments(filter, options);
    }

    aggregate<U extends Document = Document>(
        pipeline: Document[],
        options: AggregateOptions = {},
    ): AggregationCursor<U> {
        return this.collection.aggregate<U>(pipeline, options);
    }

    private applyTimestamps(update: Document): Document {
        if (!this.timestamps) {
            return update;
        }
        const next: Document = { ...update };
        const set = (next.$set ?? {}) as Document;
        if (set.updatedAt == null) {
            next.$set = { ...set, updatedAt: new Date() };
        }
        return next;
    }
}

export function defineModel<TName extends string, TSchema extends z.ZodObject<z.ZodRawShape>>(
    name: TName,
    schema: TSchema,
    options: ModelOptions = {},
): Model<TName, TSchema> {
    const model = new Model(name, schema, options);
    registerModel(name, model as unknown as Model<string, never>);
    return model;
}
