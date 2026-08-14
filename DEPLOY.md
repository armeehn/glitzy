# Deploying

Two halves, two very different places.

| | Etsch | Glitzy studio |
|---|---|---|
| Where | Cloudflare Workers (static assets) | A host you control |
| Public | Yes — <https://glitzy.ripostelabs.xyz> | No, and deliberately so |
| Needs | `wrangler` | Python 3.11+, NumPy, Pillow, ffglitch |

---

## Etsch → Cloudflare

`wrangler.toml` declares a Worker named `glitzy` with an `assets` directory and
**no `main`**. That combination means Cloudflare serves `etsch/public`
directly: no script runs on a request, so there is nothing billed per request
and no runtime to keep patched.

```sh
npm ci
npx wrangler deploy --dry-run    # validates the config, no credentials needed
npx wrangler deploy
```

### Credentials

Either works:

- **`npx wrangler login`** — OAuth in a browser, nothing long-lived stored.
- **`CLOUDFLARE_API_TOKEN`** — for a headless box. The token needs
  **Account → Workers Scripts → Edit**, **Account → Account Settings → Read**
  (wrangler discovers the account id with it), and **Zone → DNS → Edit** on the
  zone, so it can write the custom domain's record.

A token scoped only to `Zone → DNS → Edit` — the kind an ACME client uses for
DNS-01 — **is not enough and fails in a confusing way**: it authenticates fine,
`user/tokens/verify` says `active`, and then `accounts` comes back as an empty
list rather than an error, so the failure surfaces as "could not determine
account" rather than "insufficient permissions".

### The custom domain

`[[routes]] custom_domain = true` in `wrangler.toml` attaches
`glitzy.ripostelabs.xyz` on deploy, and Cloudflare writes the DNS record
itself — the zone is on the same account. Keeping the hostname in the config
rather than in the dashboard means a fresh account can be rebuilt from this
file alone.

The record it writes is a proxied `AAAA` to `100::`, which is the documented
placeholder for a Workers custom domain. It looks wrong in the DNS list and is
not.

### Checking it

```sh
curl -sI https://glitzy.ripostelabs.xyz/ | head -3
curl -s  https://glitzy.ripostelabs.xyz/ | grep -o '<title>[^<]*'
```

A 200 with the right title is the whole check. There is no server to be
unhealthy.

---

## The studio → a host you control

The studio is **not** on the public internet and should not be. It accepts file
uploads, spawns `ffgac`/`ffedit` subprocesses on them, and holds a cache keyed
on user input. It belongs behind an authenticating reverse proxy on a network
you trust. `studio/deploy/` holds the site file for that proxy.

```sh
studio/deploy.sh --restart
```

That copies the tree to the engine host and restarts `glitzyd.service`. See
[studio/README.md](studio/README.md) for what the engine needs installed.

### Memory is the operational constraint

The unit sets `MemoryMax`. This is load-bearing: a single numpy operation on a
large clip can allocate more than a gigabyte in about two seconds, and the
engine measures roughly 75 bytes per pixel per operation, not the 4 bytes an
RGBA frame suggests.

**When `MemoryMax` is hit the whole cgroup is SIGKILLed**, so the engine dies
rather than returning an error, and a reverse proxy in front of it reports a
**502**. A 502 from the studio means the engine was killed, not that it hung.
`journalctl -u glitzyd` shows the `oom-kill` line and the peak.

Because SIGKILL is not catchable, anything that would exceed the cap has to be
refused *before* it allocates. That is what `clip.check_budget()` and
`MAX_PIXELS` are for; they are not decoration, and raising them without
measuring bytes-per-pixel per operation first will just move the crash.

### Renaming an existing deployment

If you are moving a deployment that predates the Glitchsheet → Glitzy rename,
**move the data directory, do not just point at a new one**:

```sh
systemctl stop glitchd2
mv /var/lib/glitchsheet2 /var/lib/glitzy
mv /opt/glitchsheet2     /opt/glitzy
```

The store is content-addressed and its export links are meant to be permanent —
that is the whole reason it keys files on `sha1(bytes)` and evicts nothing.
Starting the renamed service against an empty `/var/lib/glitzy` does not error;
it comes up clean and every previously-shared link 404s with "that export has
expired". The service name changes from `glitchd2` to `glitzyd`; the *v1*
engine's unit is still `glitchd` and should be left alone, since it is the
rollback.
