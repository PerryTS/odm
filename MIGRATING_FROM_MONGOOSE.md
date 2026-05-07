# Migrating from Mongoose to `@perryts/odm`

> **Audience:** an LLM agent porting an existing Mongoose codebase. Apply
> rules top-to-bottom, file by file. Each rule has a *find* pattern, a
> *replace* pattern, and a why so you can judge edge cases. If you hit
> something not listed in the rules and not listed in **Impossible
> cases**, stop and ask the user — do not invent a translation.

---

## 0. Operating principles for the agent

1. **Touch nothing else.** Do not rename variables, restructure files,
   or "improve" code while porting. The diff should be reviewable as a
   pure translation.
2. **One model per file** stays one model per file. Keep the file path
   stable; users `import` by path.
3. **Schemas are runtime values, not classes.** `new mongoose.Schema(...)`
   becomes a `z.object(...)` literal. There is no `Schema` constructor
   in `@perryts/odm`.
4. **Documents are plain objects, not class instances.** A doc returned
   from `find` has no `.save()`, `.toObject()`, or `.populate()` method.
   Replace those call sites — see Rules 7, 11, 13.
5. **`populate` is at the query layer, not the document layer.** Mongoose's
   `doc.populate('field')` does not exist. Refactor callers to populate
   on the original `find` query.
6. **Never `as any` a Zod schema to silence a type error.** If the input
   type doesn't fit, the schema is wrong — fix the schema.
7. **Defaults are explicit.** `lean: true` is the default and the only
   mode. Do not port `.lean()` calls; just delete them.

---

## 1. Imports

**Find**
```ts
import mongoose, { Schema, Types, Document, Model } from 'mongoose';
```

**Replace**
```ts
import { z } from 'zod';
import { ObjectId, MongoClient } from '@perryts/mongodb';
import { defineModel, ref, before, after, initModels, type Ref } from '@perryts/odm';
```

**Why:** Mongoose bundles schema definition, the driver, and a global
connection. `@perryts/odm` only does ODM concerns; the driver is a
separate import.

`Types.ObjectId` → `ObjectId` (re-exported from `@perryts/odm` and
`@perryts/mongodb` — pick the shorter import that's already in the file).

---

## 2. Connection

**Find**
```ts
await mongoose.connect(process.env.MONGO_URI!);
```

**Replace**
```ts
const client = await MongoClient.connect(process.env.MONGO_URI!);
const db = client.db('<dbName>'); // pull <dbName> from the URI path
await initModels(db, [User, Item /* every model defined in the app */]);
```

**Why:** Mongoose's `connect()` does three things — open a connection,
register every previously-`mongoose.model(...)`-defined model on it,
and trigger lazy index creation. `@perryts/odm` makes these explicit:
`MongoClient.connect` is the connection, `initModels` is registration
+ index creation. List every model exported by the app in the
`initModels` array; missing one means `populate('field')` for a ref
to that collection will throw at query time.

If the original code uses `mongoose.connection.on('error', ...)`,
those handlers move to `client.on('error', ...)`.

---

## 3. Schema → `defineModel(name, z.object(...))`

**Find** any Mongoose schema:
```ts
const userSchema = new Schema({
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  name:     String,
  age:      { type: Number, min: 0, max: 150 },
  active:   { type: Boolean, default: true },
  joinedAt: { type: Date,    default: Date.now },
  role:     { type: String,  enum: ['admin', 'user'], default: 'user' },
  tags:     [String],
});
const User = mongoose.model('User', userSchema);
```

**Replace**
```ts
const UserSchema = z.object({
  email:    z.string().toLowerCase().trim(),
  name:     z.string().optional(),
  age:      z.number().int().min(0).max(150).optional(),
  active:   z.boolean().default(true),
  joinedAt: z.date().default(() => new Date()),
  role:     z.enum(['admin', 'user']).default('user'),
  tags:     z.array(z.string()).default([]),
});
const User = defineModel('users', UserSchema, {
  indexes: [{ keys: { email: 1 }, unique: true }],
});
```

**Field-type translation table:**

| Mongoose | Zod |
|---|---|
| `String` / `{ type: String }` | `z.string()` |
| `Number` | `z.number()` (add `.int()` if `{ type: Number, integer: true }` or used as ID) |
| `Boolean` | `z.boolean()` |
| `Date` | `z.date()` |
| `Buffer` | `z.instanceof(Buffer)` |
| `Schema.Types.ObjectId` (no ref) | `z.instanceof(ObjectId)` |
| `Schema.Types.ObjectId` + `ref` | `ref('collectionName')` — see Rule 5 |
| `Schema.Types.Mixed` | `z.unknown()` (note: no schema validation) |
| `[String]` | `z.array(z.string())` |
| `[{...}]` (subdoc array) | `z.array(z.object({...}))` |
| Nested object | `z.object({...})` |
| `Map` of `String` | `z.record(z.string(), z.string())` |

**Validator translation table:**

| Mongoose | Zod |
|---|---|
| `required: true` | (default — fields are required unless `.optional()`) |
| (omitted / not required) | `.optional()` |
| `default: X` | `.default(X)` |
| `default: () => fn()` | `.default(() => fn())` |
| `unique: true` | **NOT a validator.** Move to `indexes: [{ keys: {field: 1}, unique: true }]` |
| `lowercase: true` | `.toLowerCase()` |
| `uppercase: true` | `.toUpperCase()` |
| `trim: true` | `.trim()` |
| `enum: [...]` | `z.enum([...])` |
| `min: n` (Number) | `.min(n)` |
| `max: n` (Number) | `.max(n)` |
| `minLength: n` | `.min(n)` |
| `maxLength: n` | `.max(n)` |
| `match: /regex/` | `.regex(/regex/)` |
| `validate: { validator: fn, message }` | `.refine(fn, msg)` |

**Naming convention:** Mongoose model names are by convention singular
PascalCase ('User', 'Item'); the underlying collection name is
auto-pluralized to lowercase ('users', 'items'). `@perryts/odm` does
**not** pluralize. Pass the actual collection name (lowercase plural)
as the first arg to `defineModel`. The TypeScript identifier still
reads naturally — `const User = defineModel('users', ...)`.

---

## 4. Indexes (compound, unique, 2dsphere, TTL)

**Find** any of:
```ts
schema.index({ email: 1 }, { unique: true });
schema.index({ user: 1, item: 1 }, { unique: true });
schema.index({ location: '2dsphere' });
schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
```

**Replace** by collecting all of them into the `indexes` array on
`defineModel`:
```ts
const Foo = defineModel('foos', FooSchema, {
  indexes: [
    { keys: { email: 1 }, unique: true },
    { keys: { user: 1, item: 1 }, unique: true },
    { keys: { location: '2dsphere' } },
    { keys: { expireAt: 1 }, expireAfterSeconds: 0 },
    { keys: { createdAt: 1 }, expireAfterSeconds: 60 * 60 * 24 * 90 },
  ],
});
```

**Why:** all index creation is declarative; `initModels` runs
`createIndexes` once at startup. There is no equivalent of
Mongoose's `Model.syncIndexes()` — `initModels` *is* that.

`expireAfterSeconds: 0` (with a `Date`-typed field) = "expire when
the field's value is in the past." `expireAfterSeconds: N` = "expire
N seconds after the field's value." Same semantics as Mongo TTL.

**Inline index shorthand on a field**
```ts
email: { type: String, index: true }
email: { type: String, index: { unique: true } }
```
becomes a single non-inline index:
```ts
indexes: [{ keys: { email: 1 } }]
indexes: [{ keys: { email: 1 }, unique: true }]
```

---

## 5. Refs and populate

**Find** the schema declaration:
```ts
const itemSchema = new Schema({
  owner:        { type: Schema.Types.ObjectId, ref: 'User', required: true },
  participants: [{ type: Schema.Types.ObjectId, ref: 'User' }],
});
```

**Replace** — prefer `ref(Model)` (compile-time guarantee the target
exists), falling back to `ref('collectionName')` only when the target
model is declared later in the file (forward ref):
```ts
const ItemSchema = z.object({
  owner:        ref(User),                     // preferred
  participants: z.array(ref(User)).default([]),
});
// If User is defined below in the same file, fall back to a string ref:
//   owner: ref('users'),
```

**Find** every populate call:
```ts
const items = await Item.find({}).populate('owner');
const item = await Item.findById(id).populate('owner').populate('participants');
const item = await Item.findById(id).populate({ path: 'owner', select: 'email name' });
```

**Replace**
```ts
const items = await Item.find({}).populate('owner');
const item = (await Item.find({ _id: id }).populate('owner').populate('participants'))[0] ?? null;
// .select() is not supported on populate. Either:
//   (a) drop it (returns full doc — usually fine), or
//   (b) port to model.aggregate([...]) and add a $project stage manually.
const item = (await Item.find({ _id: id }).populate('owner'))[0] ?? null;
```

**Why:** populate lowers to `$lookup` aggregation. Selecting a subset
of fields on the joined doc requires an extra `$project` stage; rather
than baking that into the populate API, the agent should drop trivial
selects and surface non-trivial ones to the user with a comment
`// TODO: re-add field selection via aggregate $project`.

**Critical rule:** `.populate()` only exists on `Model.find()`. There
is no `findById(...).populate()` or document-level `.populate()`.
- `Model.findById(id).populate('x')` → `(await Model.find({_id:id}).populate('x'))[0] ?? null`
- `doc.populate('x')` (on an already-loaded doc) → re-query: `await Model.find({_id: doc._id}).populate('x')`

The second case is a behavior change worth flagging in a code comment
because the original may have relied on the doc instance being mutated
in place; with `@perryts/odm` you get a new doc back.

**Collection-name argument to `ref()`:** must match the lowercase
plural string passed to `defineModel`. Mongoose's `ref: 'User'`
(model name) → `ref('users')` (collection name). If unsure, grep
the codebase for `defineModel('` and copy the exact string.

---

## 6. Hooks (pre/post)

### 6a. `pre('save')` for new docs (most common — password hashing)

**Find**
```ts
userSchema.pre('save', async function (next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});
```

**Replace**
```ts
before(User, 'insert', async (doc) => {
  if (typeof doc.password === 'string' && doc.password.length > 0) {
    doc.passwordHash = await bcrypt.hash(doc.password, 10);
    doc.password = undefined;
  }
});
```

**Why and behavior changes (FLAG TO USER):**
- Mongoose `pre('save')` runs on **both** new-doc save and full-doc
  resave. `before(M, 'insert', ...)` runs only on `insert`/`insertMany`.
- Mongoose's `this.isModified('password')` is a doc-state check; in
  `@perryts/odm` you check the *input* shape. For a typical
  password-hashing hook the rewritten form above is equivalent.
- If the original schema stored the cleartext field as `password` and
  expected Mongoose to overwrite it with the hash on save, the ported
  code MUST split the cleartext input field from the stored hash field.
  Pattern: input has `password?: string`, stored has `passwordHash`,
  and the `before` hook moves cleartext → hash + deletes the cleartext.
  Update *all callers* that read `user.password` post-save.

### 6b. `pre('save')` covering updates (rare but exists)

If the original code does `doc.field = X; await doc.save();` (an
update via instance), the agent must convert each call site to
`Model.updateOne(filter, { $set: { field: X } })` and add a parallel
`before(M, 'update', ...)` hook. Replicate the pre-save logic in both
hooks. Add a comment marking the duplication so the user can decide
whether to factor it out.

### 6c. `pre('updateOne')` / `pre('findOneAndUpdate')`

```ts
schema.pre('updateOne', function () { /* mutate this.getUpdate() */ });
```

→

```ts
before(M, 'update', async (filter, update) => {
  // mutate `update` in place (e.g., update.$set.updatedAt = new Date())
});
```

### 6d. `pre('remove')` / `pre('deleteOne')` / `pre('findOneAndDelete')`

→ `before(M, 'delete', async (filter) => { ... })`. Note: the hook
receives the filter, not the doc(s) being deleted. If the original
hook reads doc fields, the port must `findOne(filter)` first inside
the hook — flag this to the user since it's an extra round trip.

### 6e. `post('save')`, `post('findOne')`, etc.

→ `after(M, 'insert' | 'update' | 'delete', ...)`. There is no
`after('find', ...)` — Mongoose's read hooks are extremely rare in
practice; if you encounter one, ask the user how they want it
ported (almost always: inline the logic at the call site).

### 6f. `pre('validate')`

`@perryts/odm` validates via Zod on every `insert`/`insertMany`. If
the Mongoose hook *adjusts* a value before validation, port the
logic into the Zod schema using `.transform(...)` or a `.preprocess()`
wrapper. If it *rejects* invalid input, port to `.refine(...)` on the
relevant Zod field.

---

## 7. Reads (find variants)

| Mongoose | `@perryts/odm` |
|---|---|
| `Model.find(filter)` | `await Model.find(filter)` |
| `Model.find(filter).lean()` | `await Model.find(filter)` (lean is the default & only mode) |
| `Model.find(filter).sort({x:-1}).limit(n)` | `await Model.find(filter, { sort: {x:-1}, limit: n })` |
| `Model.findOne(filter)` | `await Model.findOne(filter)` |
| `Model.findById(id)` | `await Model.findById(id)` |
| `Model.countDocuments(filter)` | `await Model.countDocuments(filter)` |
| `Model.exists(filter)` | `(await Model.findOne(filter, { projection: {_id:1} })) != null` |
| `Model.distinct('field')` | `await Model.collection.distinct('field')` (drop down to driver) |

`.find(...)` returns a `PopulateBuilder` that's awaitable directly
(it implements `then`) — `await Model.find({})` works. Calling
`.populate(...)` on it returns the same builder; awaiting it
executes. Call `.exec()` explicitly only when you need to delay
execution (e.g., passing the builder to a helper).

**`.cursor()` / streaming:** drop down to the driver:
`Model.collection.find(filter).stream()`.

---

## 8. Writes

| Mongoose | `@perryts/odm` |
|---|---|
| `new Model(obj); doc.save()` | `await Model.insert(obj)` (returns the inserted doc) |
| `Model.create(obj)` | `await Model.insert(obj)` |
| `Model.create([a, b, c])` | `await Model.insertMany([a, b, c])` |
| `Model.insertMany([...])` | `await Model.insertMany([...])` |
| `Model.updateOne(f, u)` | `await Model.updateOne(f, u)` (returns `modifiedCount: number`, not the result object) |
| `Model.updateMany(f, u)` | `await Model.updateMany(f, u)` |
| `Model.findOneAndUpdate(f, u, {new:true})` | `await Model.findOneAndUpdate(f, u)` (default returns post-update doc) |
| `Model.findOneAndUpdate(f, u)` (no `new:true`) | `await Model.findOneAndUpdate(f, u, { returnDocument: 'before' })` — pre-Mongoose-6 default |
| `Model.findByIdAndUpdate(id, u, {new:true})` | `await Model.findOneAndUpdate({_id: id}, u)` |
| `Model.findOneAndDelete(f)` | `await Model.findOneAndDelete(f)` |
| `Model.findByIdAndDelete(id)` | `await Model.findOneAndDelete({_id: id})` |
| `Model.deleteOne(f)` / `deleteMany(f)` | `await Model.deleteOne(f)` / `deleteMany(f)` (returns `deletedCount: number`) |
| `doc.remove()` | `await Model.deleteOne({ _id: doc._id })` |

**Result-shape change (FLAG):** Mongoose's `updateOne` returns
`{ acknowledged, matchedCount, modifiedCount, upsertedId, upsertedCount }`.
`@perryts/odm` returns just the `modifiedCount: number`. If a caller
reads `result.matchedCount` (e.g., to detect "no doc matched"),
either change the caller to read the count differently, or call
`Model.collection.updateOne(...)` directly to keep the full result.

---

## 9. Aggregations and `$geoNear`

**Find**
```ts
Model.aggregate([ ... ]);
```

**Replace** — same call, just no `.exec()`:
```ts
await Model.aggregate([ ... ]).toArray();
```

`$geoNear` works unchanged. The only requirement is a `2dsphere` index
on the field — declare it via Rule 4. Example:
```ts
const near = await Item.aggregate<{ title: string; dist: number }>([
  { $geoNear: { near: { type: 'Point', coordinates: [lng, lat] },
                distanceField: 'dist', maxDistance: 5000, spherical: true } },
]).toArray();
```

The cursor is typed via the type parameter on `aggregate<T>`.

---

## 10. Timestamps

**Find** schema option:
```ts
new Schema({...}, { timestamps: true })
```

**Replace** — declare the fields in the schema **and** pass `timestamps`
to `defineModel`:
```ts
const FooSchema = z.object({
  // ...other fields
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});
const Foo = defineModel('foos', FooSchema, { timestamps: true, indexes: [...] });
```

`@perryts/odm` will fill `createdAt` and `updatedAt` on insert and
`$set` `updatedAt` on every update. Both fields must be declared
optional in the Zod schema so user code doesn't need to pass them.

Custom field names (`{ timestamps: { createdAt: 'created_at' } }`)
are **not** supported in v0.1 — port the schema to use the default
names, or implement the timestamps as plain `before` hooks.

---

## 11. Statics, methods, virtuals

| Mongoose | `@perryts/odm` |
|---|---|
| `schema.statics.findActive = function() {...}` | export a free function: `export function findActive() { return User.find({active: true}); }` |
| `schema.methods.fullName = function() { return this.first + ' ' + this.last }` | export a free function taking the doc: `export function fullName(u: User) { return u.first + ' ' + u.last; }` and update callers from `user.fullName()` to `fullName(user)` |
| `schema.virtual('foo').get(function() {...})` | same — free function |
| `schema.virtual('foo').set(function(v) {...})` | same — free function (call sites change from assignment to function call) |

**Why no first-class statics/methods:** documents are plain objects.
Anything that would have been a method is a function that takes the
document. The mechanical rewrite is dull but mechanical: every
`x.method(args)` call becomes `method(x, args)`.

**Virtuals tagged in toJSON:** if the original schema does
`schema.set('toJSON', { virtuals: true })` to include virtuals in
serialization, the port must add the virtual field explicitly at
serialization time. Surface this to the user — there's no hidden
serialization layer.

---

## 12. Discriminators

Mongoose discriminators (single-collection inheritance with a `__t`
kind field) port to a Zod **discriminated union**:

**Find**
```ts
const eventSchema = new Schema({ when: Date }, { discriminatorKey: 'kind' });
const Event = mongoose.model('Event', eventSchema);
const Click = Event.discriminator('Click', new Schema({ url: String }));
const View  = Event.discriminator('View',  new Schema({ page: String }));
```

**Replace**
```ts
const ClickEventSchema = z.object({ kind: z.literal('Click'), when: z.date(), url: z.string() });
const ViewEventSchema  = z.object({ kind: z.literal('View'),  when: z.date(), page: z.string() });
const EventSchema = z.discriminatedUnion('kind', [ClickEventSchema, ViewEventSchema]);

// defineModel needs ZodObject — wrap by declaring a model per variant
// and having callers branch on `kind`. If the callers truly need a
// single Model handle, define it on a base ZodObject and validate
// the discriminated shape in a `before('insert')` hook.
const Event = defineModel('events', z.object({
  kind: z.string(), when: z.date(),
  url: z.string().optional(), page: z.string().optional(),
}));
before(Event, 'insert', (doc) => { EventSchema.parse(doc); });
```

This is a behavior-preserving but uglier port — surface it to the user
and ask if they'd rather split into per-kind collections.

---

## 13. Transactions

| Mongoose | `@perryts/odm` |
|---|---|
| `await mongoose.startSession()` + `session.withTransaction(...)` | Use the driver directly: `client.startSession()` + `session.withTransaction(async () => { await User.collection.updateOne(..., { session }); ... })` |

There's no ODM-level session wrapper in v0.1; pass `{ session }` via
`Model.collection.*` calls. Surface this in a comment so the user
can refactor if they prefer.

---

## 14. Connection lifecycle

| Mongoose | `@perryts/odm` |
|---|---|
| `mongoose.disconnect()` | `await client.close()` |
| `mongoose.connection.dropDatabase()` | `await db.dropDatabase()` (driver) |
| `Model.collection.drop()` | `await Model.collection.drop()` (same — `.collection` is the @perryts/mongodb Collection) |

---

## 15. Impossible cases (stop and ask)

If the original code uses any of these, **do not silently port** —
flag to the user with a comment block describing the affected lines:

- **Plugins** (`schema.plugin(...)`). No equivalent. Each plugin is a
  separate decision: inline its behavior, drop it, or write a thin
  wrapper. List the plugins for the user.
- **Mongoose change streams** in tightly-coupled-to-`Model` form. The
  driver supports `Model.collection.watch(pipeline)` — ports cleanly
  for simple cases, but watch out for code that relies on Mongoose
  hydrating the change-stream `fullDocument` through the schema; you
  need to do that hydration explicitly with `Schema.parse`.
- **Populated virtuals** (`schema.virtual('foo', { ref, localField,
  foreignField })`). Port to a manual `aggregate` with `$lookup`.
- **Auto-populate via `pre('find')`**. Port to explicit `.populate()`
  at every call site.
- **`Schema.Types.Mixed` containing other ObjectIds you populate**.
  No metadata to drive the lookup; agent cannot infer the target.
- **Anything calling `mongoose.model('Name', schema, 'customCollection')`**
  with a third arg overriding the collection name. The agent should
  use `customCollection` as the `defineModel` first arg verbatim.
- **`schema.set('autoIndex', false)`**. `@perryts/odm` builds indexes
  unconditionally in `initModels`. If the user wants opt-in indexes,
  remove the index specs from `defineModel` and surface that they
  must build them out-of-band.

---

## 16. Final pass: typechecking

After porting, run `tsc --noEmit`. Common errors and their fixes:

- *"Property 'save' does not exist on type ..."* — see Rules 7, 8.
  Convert to `Model.insert` / `Model.updateOne`.
- *"Property 'populate' does not exist on type ..."* — see Rule 5.
  Move populate from doc to query.
- *"Type 'string' is not assignable to type 'Ref<...>'"* — `ref()`
  accepts a string at the input boundary, but TS will complain at
  call sites; use `as Ref<'collectionName'>` at the call site, or
  convert with `new ObjectId(s)` first.
- *Discriminated unions in callers* — Zod's inferred type is a union;
  callers must narrow on the discriminator field before accessing
  variant-specific fields.

---

## 17. Sanity checklist

When the port is "done," verify by reading the diff:

- [ ] No `mongoose` import remains anywhere in the codebase.
- [ ] No `.save()`, `.lean()`, `.exec()` on a `find` result.
- [ ] No `Schema`, `Schema.Types`, or `mongoose.model` references.
- [ ] Every `defineModel` collection name is plural lowercase and
      matches the existing data's collection name in MongoDB.
- [ ] Every `ref('x')` argument matches a `defineModel('x', ...)`
      somewhere in the codebase.
- [ ] `initModels(db, [...])` lists every model exported by the app.
- [ ] All `before('insert', ...)` hooks that produce a hashed/derived
      field have a matching declared field in the Zod schema.
- [ ] `tsc --noEmit` is clean.
- [ ] Any `// TODO:` comments left behind are listed in the PR
      description for the user to triage.
