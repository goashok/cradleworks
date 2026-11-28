# Releasing the factory

*For maintainers. To install a release, see the [quick start](../quickstart.md#1-install-cradleworks).*

A release is one file: `cradleworks-<version>.tgz`, attached to the GitHub release `v<version>`.
It's an ordinary npm package. Projects that run the factory as a service depend on it by URL at an
exact version, rather than on a checkout of this repository.

## What's in the package

- **The `factory` command.** It's the same CLI as a checkout's, compiled to JavaScript, so it runs
  from `node_modules`. Node doesn't strip TypeScript types from files there.
- **`cradleworks/hosting`,** for a service that runs the factory for others. It has the CLI's `run`
  and `commandFor`, the Postgres store, the work item model, the console's wording, the settings
  tools (schema, loader, `explain`, the YAML library), setting a repository up, and measuring.
  It comes with type declarations. Nothing else in the package is promised to stay the same
  between versions.
- **`cradleworks/testing`:** the fakes (a scripted agent runtime, a tracker, local git), for a
  service's own tests.
- **`build-info.json`:** the version and the commit it was built from. `factoryVersion()` reads it,
  and measuring records it with each result.
- **`defaults/`, `docs/` and `skills/`,** in the same places relative to the code as in a checkout.

The only outside dependencies are `yaml` and `pg`.

## Make a release

1. **Set the new version** in the root `package.json`, then commit and push it to `main`.
2. **Build and check it locally:**

   ```sh
   pnpm build:package      # dist/cradleworks-<version>.tgz
   pnpm check:package      # installs it in an empty project and uses it
   ```

3. **Tag it and push the tag:**

   ```sh
   git tag v<version> && git push origin v<version>
   ```

   The **Release** workflow then:
   1. checks that the tag matches `package.json`;
   2. runs `pnpm check`;
   3. builds and checks the package;
   4. creates the GitHub release with the file attached and notes made from the commits.

Versions follow semantic versioning on `cradleworks/hosting`: a change that breaks it raises the
first number (or, before 1.0, the second).

**If a release is wrong,** don't move or delete its tag: something may already depend on its file
and checksum. Fix the problem and release the next version. If the workflow failed before
publishing, nothing was released: fix it, delete the tag (`git push origin :v<version>`), and tag
again.

## Depend on a release

A service that runs the factory depends on the file at an exact version:

```sh
npm install https://github.com/goashok/cradleworks/releases/download/v<version>/cradleworks-<version>.tgz
```

That puts the URL in `package.json`, and the lockfile pins the file's checksum.
