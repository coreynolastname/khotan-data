# Khotan Playground

This is the one in-repo app for visually checking generated Khotan UI and local
DX. It is not part of the package build or test suite.

From the repository root:

```bash
npm run playground
```

That command builds `khotan-data`, packs a tarball, installs the tarball into
this app, scaffolds the Khotan core files plus `/config`, and starts `next dev`.

Use install-only mode when you want to inspect generated files without starting
the dev server:

```bash
npm run playground:install
```

Set `KHOTAN_PLAYGROUND_SKIP_SCAFFOLD=1` to only refresh the tarball install.
