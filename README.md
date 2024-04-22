# tsrf

**🚧 Work in progress, [follow for updates](https://twitter.com/kossnocorp)**

tsrf is a build tool that elevates developer experience and performance of type-checking TypeScript code in a monorepo.

It combines the power of [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) with [TypeScript Project References](https://www.typescriptlang.org/docs/handbook/project-references.html)

It automatically maintains the dependencies tree for each module, removing the need for you to manually update `tsconfig.json` or `package.json` for every module.

## Why to use tsrf?

Type-checking in a monorepo was always a compromise:

1. You either run separate `tsc` instances for each module and have accurate but messy reports and poor performance.

2. Or you give up on accuracy and use a single `tsconfig.json` but open doors for bugs and incompatibility between modules.

3. Or you use [TypeScript Project References](https://www.typescriptlang.org/docs/handbook/project-references.html) to address said problems but spend your time tediously maintaining references between modules.

tsrf solves this dilemma by automatically detecting and updating references so you can have accuracy, performance, and time to work on what's important.

Additionally, it maintains module dependencies so you don't have to add a workspace module to `package.json` every time you start using it.

## Getting started

To get started, install [`tsrf` npm package](https://www.npmjs.com/package/tsrf):

```bash
npm install tsrf
```

Now run the doctor command to check the compatibility and required changes:

```bash
npx tsrf doctor
```

It will give you a breakdown of required changes that can be made via `doctor --fix`:

```bash
npx tsrf doctor --fix
```

Now you're ready to start the watch mode:

```bash
npx tsrf
```

It [will patch the project configs](#what-it-does) to match the necessary settings and run the compiler in watch mode.

## How does it work?

tsrf wraps the TypeScript compiler and updates references in the background using the build information reported by TypeScript.

You simply run `tsrf` instead of `tsc --build --watch`, and tsrf will do the rest.

### What it does:

1. It updates the root `tsconfig.json` and updates the [`references`](https://www.typescriptlang.org/tsconfig#references) to include all [matching modules](#what-is-a-matching-module) within [the workspaces specified in the `package.json`](https://docs.npmjs.com/cli/using-npm/workspaces). tsrf also updates the config settings to make the references work properly.

2. It updates `references` and path aliases in each [matching module](#what-is-a-matching-module) `tsconfig.json` using the dependencies tree parsed from the build info provided by the compiler. Just like with the root config, tsrf also makes sure the config settings are properly set.

3. It updates `package.json` dependencies and adds missing workspace modules when you start using one.

## FAQ

### Can I use it with a monorepo build tool?

I personally use it with [Turborepo](https://turbo.build/repo) and I'm sure you can use it with any or no monorepo build tool at all.

### What is a matching module?

A matching module is a module specified or matched by the glob pattern in the `package.json` `workspaces` property. Additionally, the module should have a valid `package.json` and `tsconfig.json`.

## Changelog

See [the changelog](./CHANGELOG.md).

## License

[MIT © Sasha Koss](./LICENSE.md)
