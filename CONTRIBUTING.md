# How changes reach Nova

`develop` is the default branch, and where every change starts. `main` holds what has been
released, and changes only through pull requests from `develop`. Nobody pushes to either
directly - not even admins.

1. **Branch from `develop`**, named for what it is:
   - `feature/<name>` - something new
   - `bugfix/<name>` - a bug
   - `hotfix/<name>` - an urgent fix
2. **Open a pull request into `develop`.** CI runs (typecheck, tests, a build of the window) and
   checks the branch name. Review it, fix what the review finds, then turn on auto-merge
   (squash): it merges once the checks pass, and the branch is deleted. If the change alters how
   the window looks, `npm run readme:media` takes the README's pictures again.
3. **Release: open a pull request from `develop` into `main`** (merge commit). When it merges,
   a workflow branches the release off `main` as `release/v<version>` (the version in the root
   `package.json`). Release branches can't be deleted or rewritten.

`main`, `develop` and `release/*` are protected by repository rules; CI is in `.github/workflows`.
