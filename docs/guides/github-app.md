# Short-lived GitHub tokens with a GitHub App

By default the factory talks to GitHub as you, with `GITHUB_TOKEN` or your `gh` login. That
token can do whatever you can, on every repository you can reach, until you revoke it.

A GitHub App gives the factory its own identity instead. Each token it uses:

- lasts **one hour** and is refreshed automatically;
- sees **only the repositories the app is installed on** (or fewer, if you list them);
- carries **only these permissions**: contents, pull requests and issues (write), checks and
  actions (read), metadata (read). No admin, workflows, secrets or settings.

Pull requests, comments and commits then show the app as the author, not you. That makes it
easy to tell at a glance what the factory did.

It's off unless you configure it.

## Set it up

1. **Create the app.** In GitHub: *Settings → Developer settings → GitHub Apps → New GitHub App*
   (or the same under an organisation).
   - Name it, for example `yourname-factory`. Set any homepage URL, and untick *Webhook → Active*.
   - **Repository permissions:** Contents *Read and write*, Pull requests *Read and write*,
     Issues *Read and write*, Checks *Read-only*, Actions *Read-only*. Metadata is always
     read-only. Leave everything else at *No access*.
   - *Where can this app be installed?* Only on this account.
2. **Generate a private key** on the app's page (*Private keys → Generate*). Keep the `.pem` file
   somewhere only you can read, outside every repository:
   ```sh
   mkdir -p ~/.config/cradleworks && mv ~/Downloads/*.private-key.pem ~/.config/cradleworks/github-app.pem
   chmod 600 ~/.config/cradleworks/github-app.pem
   ```
3. **Install the app** (*Install App*) and choose **Only select repositories**: the repositories
   the factory works on.
4. **Tell the factory**, in the shell you run `factory` from:
   ```sh
   export CRADLEWORKS_GITHUB_APP_ID=123456          # "App ID" on the app's page
   export CRADLEWORKS_GITHUB_APP_PRIVATE_KEY_FILE=~/.config/cradleworks/github-app.pem
   # Only if the app has more than one installation:
   export CRADLEWORKS_GITHUB_APP_INSTALLATION_ID=7890123
   # Optional: narrow each token further, to repository names under that installation:
   export CRADLEWORKS_GITHUB_APP_REPOSITORIES=ref-orders-service,ref-notifications-service
   ```
5. **Check it:** `factory validate` works as before. The next pull request the factory opens is
   authored by `yourname-factory[bot]`.

Where secrets live in environment variables rather than files, as on most hosting services, set
`CRADLEWORKS_GITHUB_APP_PRIVATE_KEY` to the key itself instead of the file's path.

To switch back, unset `CRADLEWORKS_GITHUB_APP_ID` and `CRADLEWORKS_GITHUB_APP_PRIVATE_KEY_FILE`.

## What this does and doesn't change

- The token is used only on your machine: for the GitHub API and for `git push`/`fetch` (passed
  through an environment variable, never written to a git config). It never enters a sandbox.
  Agents can't push in any case: the factory pushes on their behalf, and only `factory/*`
  branches.
- Branch protection still applies to the app. Require a review on `main`, and the app can't
  merge until a person approves, whatever `auto_merge` says.
- If the key leaks, revoke it on the app's page. Tokens already minted from it last at most an
  hour.
