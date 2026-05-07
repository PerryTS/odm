import { z } from 'zod';
import { ObjectId, isValidObjectId } from '@perryts/mongodb';

const REF_TARGET = Symbol.for('@perryts/odm/refTarget');

export type Ref<TName extends string> = ObjectId & { readonly __ref: TName };

/** Structural shape of a Model — duplicated to avoid a circular import. */
interface ModelLike<TName extends string> {
    readonly name: TName;
}

/**
 * Declare a field as a reference to another collection. Two forms:
 *
 *   ref('users')   // string — for forward refs (circular schemas)
 *   ref(User)      // model  — preferred; the model must be defined
 *                  //          earlier in the file, and TS guarantees
 *                  //          the target exists at compile time
 *
 * Both produce the same runtime: a Zod schema accepting an ObjectId
 * or a 24-char hex string, transforming to a branded `Ref<TName>`.
 * The brand drives `populate(field)` lookup at query-build time.
 */
export function ref<TName extends string>(
    target: TName,
): z.ZodType<Ref<TName>, z.ZodTypeDef, Ref<TName> | string>;
export function ref<TName extends string>(
    target: ModelLike<TName>,
): z.ZodType<Ref<TName>, z.ZodTypeDef, Ref<TName> | string>;
export function ref<TName extends string>(
    target: TName | ModelLike<TName>,
): z.ZodType<Ref<TName>, z.ZodTypeDef, Ref<TName> | string> {
    const name: TName = typeof target === 'string' ? target : target.name;
    const schema = z
        .union([
            z.instanceof(ObjectId),
            z.string().refine((s) => isValidObjectId(s), { message: 'Invalid ObjectId' }),
        ])
        .transform((v) => (typeof v === 'string' ? new ObjectId(v) : v) as Ref<TName>);
    (schema as unknown as { [REF_TARGET]: string })[REF_TARGET] = name;
    return schema as z.ZodType<Ref<TName>, z.ZodTypeDef, Ref<TName> | string>;
}

/**
 * Walk through ZodOptional / ZodNullable / ZodDefault wrappers to find a
 * ref marker. Used by populate() to discover the target collection of a
 * field at query-build time.
 *
 * Returns the target collection name if the field is a ref, or null.
 * For arrays of refs, returns the inner ref target — populate handles
 * the array case by treating localField as a path.
 */
export function getRefTarget(zodType: unknown): string | null {
    let cur: unknown = zodType;
    while (cur != null && typeof cur === 'object') {
        const marker = (cur as { [REF_TARGET]?: string })[REF_TARGET];
        if (typeof marker === 'string') {
            return marker;
        }
        const def = (cur as { _def?: { typeName?: string; innerType?: unknown; schema?: unknown; type?: unknown } })._def;
        if (def == null) {
            return null;
        }
        const tn = def.typeName;
        if (tn === 'ZodOptional' || tn === 'ZodNullable' || tn === 'ZodDefault') {
            cur = def.innerType;
            continue;
        }
        if (tn === 'ZodEffects') {
            cur = def.schema;
            continue;
        }
        if (tn === 'ZodArray') {
            cur = def.type;
            continue;
        }
        return null;
    }
    return null;
}
