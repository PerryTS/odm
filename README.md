# @perryts/odm

Value-oriented MongoDB ODM for TypeScript. Sits on
[`@perryts/mongodb`](https://github.com/PerryTS/mongodb). Zero native
dependencies. Compiles to a native binary via
[Perry](https://github.com/PerryTS) (LLVM AOT).

```bash
npm install @perryts/odm @perryts/mongodb zod
```

```ts
import { z } from 'zod';
import { MongoClient } from '@perryts/mongodb';
import { defineModel, ref, before, initModels, type Ref } from '@perryts/odm';
import bcrypt from 'bcrypt';

const UserSchema = z.object({
  email: z.string().toLowerCase().trim(),
  password: z.string().optional(),
  passwordHash: z.string().optional(),
});
const User = defineModel('users', UserSchema, {
  indexes: [{ keys: { email: 1 }, unique: true }],
});
before(User, 'insert', async (doc) => {
  if (doc.password) {
    doc.passwordHash = await bcrypt.hash(doc.password, 10);
    doc.password = undefined;
  }
});

const ItemSchema = z.object({
  title: z.string(),
  owner: ref('users'),
  location: z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number(), z.number()]),
  }),
  expireAt: z.date().optional(),
});
const Item = defineModel('items', ItemSchema, {
  indexes: [
    { keys: { location: '2dsphere' } },
    { keys: { expireAt: 1 }, expireAfterSeconds: 0 },
  ],
});

const client = await MongoClient.connect(process.env.MONGO_URI!);
await initModels(client.db('app'), [User, Item]);

const alice = await User.insert({ email: 'alice@example.com', password: 'secret' });
await Item.insert({
  title: 'Bike',
  owner: alice._id as Ref<'users'>,
  location: { type: 'Point', coordinates: [-122.42, 37.77] },
});

const items = await Item.find({}).populate('owner');
const near  = await Item.aggregate([
  { $geoNear: { near: { type: 'Point', coordinates: [-122.42, 37.77] },
                distanceField: 'dist', maxDistance: 5000, spherical: true } },
]).toArray();
```

## Design

- **Schemas are runtime values.** A `defineModel` call takes a Zod
  object schema, an optional list of indexes, and an optional
  `timestamps` flag. There is no `Schema` constructor.
- **Documents are plain objects.** No class wrapping, no `.save()`,
  no Mongoose-style document mutation. `Model.insert(obj)` takes a
  Zod-input shape, validates it, writes it, and returns the stored
  doc with `_id`.
- **Refs are branded `ObjectId`s.** `ref('users')` is a Zod schema
  whose inferred type is `ObjectId & { __ref: 'users' }`. The brand
  is what `populate('field')` uses to look up the target collection
  at query-build time — no string typos pointing nowhere.
- **`populate` is a query-builder concern.** `Model.find(filter).populate('owner')`
  lowers to a `$lookup`-augmented aggregation pipeline. Multiple
  `.populate()` chains are stacked.
- **Indexes are declared, applied at startup.** `initModels(db, [...])`
  binds each model to a MongoDB collection and runs `createIndexes`
  for every declared index — including `2dsphere`, compound,
  unique, and TTL (`expireAfterSeconds`).
- **Hooks are functions, not middleware.** `before(Model, 'insert' | 'update' | 'delete', fn)`
  registers a hook. `pre-save` for password hashing maps to
  `before(User, 'insert', ...)`.
- **Aggregate is a passthrough.** `Model.aggregate<T>(pipeline)`
  returns the driver's `AggregationCursor<T>`. `$geoNear`, `$lookup`,
  `$facet`, anything Mongo supports.

## Migrating from Mongoose

See [MIGRATING_FROM_MONGOOSE.md](./MIGRATING_FROM_MONGOOSE.md) — written
as a rule book for an LLM agent doing a mechanical port.

## What's not in v0.1

- No first-class transactions API (use `client.startSession()` and pass
  `{ session }` through `Model.collection.*`).
- No first-class change streams (use `Model.collection.watch(...)`).
- No plugin system. Compose with plain functions.
- No custom timestamp field names (`createdAt` / `updatedAt` only).
- `populate(...).select(...)` is not supported. Use `aggregate` with
  a manual `$project` stage if you need field selection on joins.
- Discriminated unions are supported via Zod but `defineModel` itself
  takes a `ZodObject`. Validate the discriminator in a `before` hook
  if you need a single Model handle.

## License

MIT
