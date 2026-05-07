import type { z } from 'zod';
import type { Document, FindOptions } from '@perryts/mongodb';
import type { Model } from './model';
import { getRefTarget } from './ref';
import { getModel } from './registry';

interface PopulateStage {
    field: string;
    target: string;
    /** Underlying Zod field schema — used to detect array refs. */
    isArray: boolean;
}

/**
 * Builder returned by `Model.find()`. If no `.populate()` is chained,
 * `.exec()` lowers to a regular `find` cursor and returns its array.
 * Otherwise the find lowers to an aggregation:
 *
 *   [{$match: filter}, ...projection/sort/skip/limit, ...$lookup/$unwind/$set per populate]
 *
 * The result rows have the populated fields replaced inline by the
 * joined document (or array of documents, for array refs).
 */
export class PopulateBuilder<TDoc extends Document, TSchema extends z.ZodObject<z.ZodRawShape>> {
    private readonly model: Model<string, TSchema>;
    private readonly filter: Document;
    private readonly options: FindOptions;
    private readonly stages: PopulateStage[] = [];

    constructor(model: Model<string, TSchema>, filter: Document, options: FindOptions) {
        this.model = model;
        this.filter = filter;
        this.options = options;
    }

    /**
     * Resolve `field`, an ObjectId ref on this model, into the
     * referenced document(s). Mongoose: `.populate('owner')`.
     *
     * The target collection is read from the schema's `ref()` brand
     * — no string lookup, no risk of typos pointing to nothing.
     */
    populate(field: keyof z.input<TSchema> & string): this {
        const shape = (this.model.schema as unknown as { shape: Record<string, unknown> }).shape;
        const fieldSchema = shape[field];
        if (fieldSchema == null) {
            throw new Error(
                `populate("${field}"): field does not exist on schema for "${this.model.name}".`,
            );
        }
        const target = getRefTarget(fieldSchema);
        if (target == null) {
            throw new Error(
                `populate("${field}"): field is not a ref. Declare it as ref("collectionName") in the schema.`,
            );
        }
        const isArray = isArrayField(fieldSchema);
        this.stages.push({ field, target, isArray });
        return this;
    }

    async exec(): Promise<TDoc[]> {
        if (this.stages.length === 0) {
            const cur = this.model.collection.find(this.filter, this.options);
            return (await cur.toArray()) as unknown as TDoc[];
        }

        const pipeline: Document[] = [{ $match: this.filter }];
        if (this.options.sort !== undefined) {
            pipeline.push({ $sort: this.options.sort });
        }
        if (this.options.skip !== undefined) {
            pipeline.push({ $skip: this.options.skip });
        }
        if (this.options.limit !== undefined) {
            pipeline.push({ $limit: this.options.limit });
        }

        for (let i = 0; i < this.stages.length; i++) {
            const s = this.stages[i];
            const targetModel = getModel(s.target);
            if (targetModel == null) {
                throw new Error(
                    `populate("${s.field}"): target model "${s.target}" not initialized. ` +
                        `Did you include it in initModels(db, [...])?`,
                );
            }
            pipeline.push({
                $lookup: {
                    from: s.target,
                    localField: s.field,
                    foreignField: '_id',
                    as: `__pop_${s.field}`,
                },
            });
            if (s.isArray) {
                pipeline.push({ $set: { [s.field]: `$__pop_${s.field}` } });
            } else {
                pipeline.push({
                    $set: {
                        [s.field]: { $arrayElemAt: [`$__pop_${s.field}`, 0] },
                    },
                });
            }
            pipeline.push({ $unset: `__pop_${s.field}` });
        }

        if (this.options.projection !== undefined) {
            pipeline.push({ $project: this.options.projection });
        }

        const cur = this.model.collection.aggregate<TDoc>(pipeline);
        return await cur.toArray();
    }

    then<TResult1 = TDoc[], TResult2 = never>(
        onFulfilled?: ((value: TDoc[]) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        return this.exec().then(onFulfilled, onRejected);
    }
}

function isArrayField(zodType: unknown): boolean {
    let cur: unknown = zodType;
    while (cur != null && typeof cur === 'object') {
        const def = (cur as { _def?: { typeName?: string; innerType?: unknown; schema?: unknown; type?: unknown } })._def;
        if (def == null) {
            return false;
        }
        const tn = def.typeName;
        if (tn === 'ZodArray') {
            return true;
        }
        if (tn === 'ZodOptional' || tn === 'ZodNullable' || tn === 'ZodDefault') {
            cur = def.innerType;
            continue;
        }
        if (tn === 'ZodEffects') {
            cur = def.schema;
            continue;
        }
        return false;
    }
    return false;
}
