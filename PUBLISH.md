# Publishing Navion to npm

The `403 Forbidden` error during `npm publish` means your npm account requires two-factor authentication (2FA) for publishing. This is an account setting, not a package bug.

## Prerequisites

1. You own the `navion` package name (currently unclaimed on npm).
2. You are logged into the npm account that will publish the package.

## Step 1: Enable 2FA for publishing

1. Go to [npmjs.com](https://www.npmjs.com/) and sign in.
2. Open **Account** → **Account Security**.
3. Enable **Two-Factor Authentication**.
4. Set 2FA to **Authorization and Publishing** (required for `npm publish`).

## Step 2: Log in locally

```bash
cd Navion
npm login
```

Verify:

```bash
npm whoami
```

## Step 3: Check package name availability

```bash
npm view navion
```

- If you see `404 Not Found`, the name `navion` is available.
- If the name is taken by another user, use a scoped name in `package.json` instead:

```json
{
  "name": "@your-npm-username/navion",
  "publishConfig": {
    "access": "public"
  }
}
```

Scoped packages need `"access": "public"` (already set in this repo) to install without an npm login.

## Step 4: Dry-run (optional)

```bash
cd Navion
npm pack --dry-run
```

Confirm only `server.js`, `src/`, `README.md`, and `package.json` are included.

## Step 5: Publish with OTP

When 2FA is enabled, publishing requires a one-time password from your authenticator app:

```bash
cd Navion
npm publish --otp=XXXXXX
```

Replace `XXXXXX` with the current 6-digit code from your 2FA app.

## Alternative: Granular access token (CI / automation)

For CI or scripts that cannot enter an OTP interactively:

1. Go to [npmjs.com](https://www.npmjs.com/) → **Access Tokens** → **Generate New Token** → **Granular Access Token**.
2. Set **Packages and scopes** to allow **Read and write** on `navion` (or your scoped name).
3. Under permissions, enable **Bypass 2FA for publish** if your org/account allows it.
4. Save the token and use it in CI:

```bash
npm config set //registry.npmjs.org/:_authToken YOUR_TOKEN
npm publish
```

Do not commit tokens to git.

## After publish

Update Navion-App to use the published package instead of the local file link:

```json
"dependencies": {
  "navion": "^1.0.0"
}
```

Then reinstall:

```bash
cd Navion-App
npm install
```

For local development, keep `"navion": "file:../Navion"`.
