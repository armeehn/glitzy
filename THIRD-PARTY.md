# Third-party software and attribution

Glitzy is MIT-licensed (see [LICENSE](LICENSE)), but almost none of the
interesting work in it is ours. This file records what Glitzy stands on, what
each piece is licensed under, and — where a licence asks something of us —
what we actually do about it.

Versions below are the ones the project is developed and tested against. They
are recorded so a claim here can be checked, not because other versions are
forbidden.

---

## The studio (`studio/`)

### ffglitch — ffedit and ffgac

**This is the reason the studio exists.** Every `codec.*` operation — smear,
tail, sink, storm, freeze, blockquant, bleed — is an ffedit script that
rewrites motion vectors and quantisation coefficients *inside* an MPEG-2
bitstream. That is not an effect anyone can reimplement in numpy; it is
datamoshing done properly, on the compressed representation, and ffglitch is
what makes it addressable at all.

| | |
|---|---|
| Project | [ffglitch](https://ffglitch.org/) by Ramiro Polla |
| Version used | `ffglitch-0.10.2` |
| Upstream | FFmpeg, © 2000–2024 the FFmpeg developers; FFglitch © 2017–2024 Ramiro Polla |
| Licence | **GPL-2.0-or-later** — the binaries are configured `--enable-gpl` |
| How Glitzy uses it | Executed as a **separate process** (`subprocess`), never linked |
| Distributed here? | **No.** Not vendored, not bundled, not redistributed |

**On the copyleft.** ffglitch is GPL and Glitzy is MIT, so this is worth being
precise about rather than hand-waving.

- Glitzy invokes `ffgac` and `ffedit` as separate programs over a pipe and the
  filesystem. It does not link against libav*, does not include ffglitch
  source, and does not ship its binaries. Running a GPL program is expressly
  not a trigger for the GPL's distribution terms — GPLv2 §0, "the act of
  running the Program is not restricted".
- `studio/rack/*.js` are our scripts, executed *by* ffedit's embedded QuickJS
  interpreter. Being input to an interpreter does not make a work a derivative
  of it, the same way a shell script is not a derivative of bash.
- **If you build a distribution that includes ffglitch binaries** — a Docker
  image, an appliance, an installer — then *that* distribution conveys GPL
  software and the GPL's obligations attach to it (offer of source,
  etc.). Glitzy's own MIT licence does not change that, and nothing in this
  repository does it for you. The studio expects ffglitch to be installed from
  upstream on the machine that runs it, deliberately — see
  [studio/README.md](studio/README.md).

QuickJS, the interpreter ffedit embeds, is by Fabrice Bellard and Charlie
Gordon and is MIT-licensed. It arrives as part of ffglitch; we neither ship it
nor call it directly.

### NumPy

| | |
|---|---|
| Project | [NumPy](https://numpy.org/) |
| Version | 2.2.4 |
| Licence | BSD-3-Clause, © 2005–2024 NumPy Developers |

Every non-codec operation is numpy. The seven generators, the whole pixel,
colour, geometry, matte and time families, the compositor and the bilinear
sampler are all array work. The `Clip` abstraction that lets one operation
serve both stills and video is a numpy array with a frame axis and nothing
more.

### Pillow

| | |
|---|---|
| Project | [Pillow](https://python-pillow.org/), the friendly PIL fork |
| Version | 11.1.0 |
| Licence | MIT-CMU (the permissive historic PIL licence) — [full text](https://github.com/python-pillow/Pillow/blob/main/LICENSE) |

Image decoding and encoding, and the GIF and APNG writers.

### JetBrains Mono

| | |
|---|---|
| Project | [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) |
| Version | 2.211 (variable, `wght` 100–800), Latin subset |
| Licence | **SIL Open Font License 1.1**, © 2020 The JetBrains Mono Project Authors |
| Bundled here? | **Yes** — `studio/web/fonts/jetbrains-mono-latin.woff2` |

This is the one dependency Glitzy actually redistributes, so it is the one
with live obligations. OFL 1.1 §1 requires the copyright notice and the
licence to travel with the font in any redistribution, source or binary.

**The full licence therefore ships next to the font, at
[`studio/web/fonts/JetBrainsMono-OFL.txt`](studio/web/fonts/JetBrainsMono-OFL.txt).**
If the font file is ever moved, copied into a build output, or vendored into
another tree, that text has to go with it. It was missing until 2026-08-14;
the font had been redistributed without it.

The Reserved Font Name clause matters too: the file must not be renamed to
something containing "JetBrains Mono" if it is ever modified or subset
further. The bundled file is an unmodified upstream Latin subset.

### Python standard library

`http.server` is the whole web server. Licensed under the PSF License
Agreement. There is no framework here and that is on purpose.

---

## The cutting tool (`etsch/`)

Etsch has **no runtime dependencies at all**. It is plain ES modules, HTML and
CSS, with no build step and nothing vendored — the deployed
`Content-Security-Policy` is `default-src 'self'`, which is enforceable
precisely because there is no third-party script to allow. Nothing an Etsch
user opens leaves their machine.

Its development dependencies are not shipped to anyone:

| Package | Version | Licence | Used for |
|---|---|---|---|
| [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) | 1.0.3 | MIT | A real canvas in tests, so contour tracing and the PNG/PDF writers are exercised for real rather than mocked |
| [jsdom](https://github.com/jsdom/jsdom) | 30.0.1 | MIT | DOM tests without a browser |
| [wrangler](https://github.com/cloudflare/workers-sdk) | 4.86.0 | MIT OR Apache-2.0 | Deploying to Cloudflare |
| [sharp](https://github.com/lovell/sharp) | 0.34.5 | Apache-2.0 | Pulled in transitively by the toolchain |

`npm ci` fetches many more packages transitively; run `npm ls --all` for the
resolved tree, and `npm sbom --sbom-format=cyclonedx` for a machine-readable
inventory with licences.

### Formats and conventions Etsch implements

These are not dependencies — nothing is copied from them — but they are other
people's specifications, and naming them is the honest thing to do.

- **`CutContour`** is the de-facto spot-colour and layer name that cutting
  software looks for when deciding which paths are cut rather than printed. It
  originates with Roland's VersaWorks and is understood by Illustrator, Esko
  and the rest of the print-and-cut world. **This is why it is the one string
  in the codebase the rename was not allowed to touch** — a file with a
  differently-named layer is a file no machine will cut.
- **DXF** is Autodesk's drawing interchange format. Etsch writes the documented
  minimal `ENTITIES` subset (`LWPOLYLINE`) by hand.
- **PDF** output is written directly against the PDF specification (ISO
  32000), including `TrimBox` and vector cut paths.

### Trademarks

Etsch ships machine profiles named **Cricut**, **Silhouette** and **Roland**,
and writes registration marks those machines' software expects to find.

Those names are the trademarks of their respective owners. They appear here
only to say which machine a profile is for — nominative use. **Glitzy and
Etsch are not affiliated with, endorsed by, or sponsored by Cricut, Silhouette
America, or Roland DG.** Nothing here is derived from their software, and the
mark geometry is implemented from published dimensions and measurement.

---

## Checking this file

It is meant to be verifiable, not decorative:

```sh
npm ls --all                         # the resolved Node tree
npm sbom --sbom-format=cyclonedx     # machine-readable, with licences
ffedit -version                      # confirms the ffglitch build and its GPL flags
python3 -c "import numpy, PIL; print(numpy.__version__, PIL.__version__)"
```

If you add a dependency, vendor a file, or bundle an asset, add it here in the
same commit. A dependency list that is updated later is a dependency list that
is wrong now.
