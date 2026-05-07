import type { Db, Document } from '@perryts/mongodb';
import type { Model } from './model';

/**
 * Bind a list of models to a database connection and apply each
 * model's declared indexes. Idempotent — MongoDB's `createIndexes`
 * is a no-op when an identical spec already exists. Throws (and
 * surfaces the underlying server error) if an index conflict
 * exists, e.g. an existing index has the same name but different
 * keys; the caller is expected to fix the conflict, not catch.
 *
 * Mongoose users: this is `mongoose.connect(...)` plus the implicit
 * `Model.init()` Mongoose runs on first use, made explicit.
 */
export async function initModels(db: Db, models: Model<string, never>[]): Promise<void> {
    for (let i = 0; i < models.length; i++) {
        const m = models[i];
        m._bind(db);
    }
    for (let i = 0; i < models.length; i++) {
        const m = models[i];
        for (let j = 0; j < m.indexes.length; j++) {
            const ix = m.indexes[j];
            const opts: Document = {};
            if (ix.unique !== undefined) opts.unique = ix.unique;
            if (ix.sparse !== undefined) opts.sparse = ix.sparse;
            if (ix.expireAfterSeconds !== undefined) opts.expireAfterSeconds = ix.expireAfterSeconds;
            if (ix.partialFilterExpression !== undefined) opts.partialFilterExpression = ix.partialFilterExpression;
            if (ix.collation !== undefined) opts.collation = ix.collation;
            if (ix.name !== undefined) opts.name = ix.name;
            await m.collection.createIndex(ix.keys as Document, opts);
        }
    }
}
