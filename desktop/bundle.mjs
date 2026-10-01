/**
 * Assembles the `.app`, and installs it if asked.
 *
 * `cargo build` makes a binary. macOS will not treat a binary as an
 * application: no Dock icon of its own, no place in Spotlight, no entry in
 * Launchpad, and a Keychain item that belongs to a path rather than to a
 * program. What it wants is a bundle — a directory with a known shape.
 *
 * This exists because the first bundle was put together by hand, which meant
 * the only record of how was a terminal's scrollback. It got two things wrong
 * that nobody could have noticed without looking:
 *
 *  - the `.icns` held **one** size, 512, so every place macOS draws the icon
 *    smaller or larger scaled that one image — the 16-pixel Finder list and
 *    the 1024-pixel preview alike;
 *  - the bundle was never signed, only linker-signed, so its `Info.plist` was
 *    not bound to it and its resources were not sealed.
 *
 * `cargo tauri build` would do this too, and better, but the Tauri CLI is not a
 * dependency of this repository — it is a separate `cargo install` with its own
 * build — and it also wants to make a `.dmg` nobody asked for. A bundle is a
 * plist, a binary and an icon, so this writes the three.
 *
 * It does not sign properly, because signing properly needs a certificate and a
 * certificate lives in Xcode. The ad-hoc signature below is well-formed and
 * nothing more; see "One wrinkle of an unsigned build" in `README.md` for what
 * that costs.
 *
 * Run:
 *   node bundle.mjs             # build and assemble into target/release/bundle
 *   node bundle.mjs --install   # and replace /Applications/ndBrain.app with it
 *   node bundle.mjs --debug     # the debug profile, for a quick look
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPLICATIONS = '/Applications';

const install = process.argv.includes('--install');
const profile = process.argv.includes('--debug') ? 'debug' : 'release';

/** The binary's name, from the manifest, so the plist cannot name the wrong one. */
const EXECUTABLE = 'ndbrain-desktop';

const conf = JSON.parse(readFileSync(join(HERE, 'app', 'tauri.conf.json'), 'utf8'));
const { productName, version, identifier } = conf;
const minimumSystemVersion = conf.bundle?.macOS?.minimumSystemVersion ?? '11.0';
for (const [key, value] of Object.entries({ productName, version, identifier })) {
  if (typeof value !== 'string' || value === '') throw new Error(`tauri.conf.json has no ${key}`);
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: HERE, stdio: 'inherit', ...options });

/* ---- the binary ---------------------------------------------------------- */

run('cargo', ['build', '--bin', EXECUTABLE, ...(profile === 'release' ? ['--release'] : [])]);
const binary = join(HERE, 'target', profile, EXECUTABLE);

/* ---- the icon ------------------------------------------------------------ */

/**
 * Every size macOS asks for, as an `.icns`.
 *
 * `iconutil` takes a directory of exactly these names and nothing else; a name
 * it does not know makes it fail rather than ignore the file. The sizes are
 * Apple's set, and the point of writing all of them is that the system then
 * never scales: the 16-pixel row in a Finder list, the Dock, ⌘-Tab and the
 * 1024-pixel preview each get an image drawn at that size.
 *
 * `sips` and `iconutil` ship with macOS, which is the only reason this does not
 * need an image library — the same reason `icons.mjs` draws its PNGs by hand.
 */
function icns(source, into) {
  /**
   * `[point size, scale] → the four-character type that lands in the file`.
   *
   * One table drives both halves, so the check below cannot test for something
   * other than what was written. The types are not a sequence — `ic11` is 16 pt
   * at 2x and sits between `ic05` and `ic12` — which is precisely why the
   * mapping is written out rather than computed.
   */
  const SIZES = [
    [16, 1, 'ic04'],
    [16, 2, 'ic11'],
    [32, 1, 'ic05'],
    [32, 2, 'ic12'],
    [128, 1, 'ic07'],
    [128, 2, 'ic13'],
    [256, 1, 'ic08'],
    [256, 2, 'ic14'],
    [512, 1, 'ic09'],
    [512, 2, 'ic10'],
  ];

  const iconset = join(mkdtempSync(join(tmpdir(), 'ndbrain-icon-')), 'icon.iconset');
  mkdirSync(iconset, { recursive: true });
  for (const [points, scale] of SIZES) {
    const name = `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`;
    const pixels = points * scale;
    run('sips', ['-z', String(pixels), String(pixels), source, '--out', join(iconset, name)], {
      stdio: 'ignore',
    });
  }
  run('iconutil', ['--convert', 'icns', iconset, '--output', into], { stdio: 'ignore' });
  rmSync(dirname(iconset), { recursive: true, force: true });

  // What was wrong before, as a check: a set that lost a size would otherwise
  // look fine until somebody opened a Finder window in list view.
  //
  // By name, not by count. Counting was the first version of this, and it
  // passed with a size missing — `iconutil` writes an `info` chunk of its own,
  // so nine images and the chunk came to ten and ten was the number expected.
  const written = readFileSync(into);
  const present = new Set();
  for (let at = 8; at < written.length; ) {
    present.add(written.toString('ascii', at, at + 4));
    const length = written.readUInt32BE(at + 4);
    if (length < 8) throw new Error(`${into} is malformed at byte ${at}`);
    at += length;
  }
  const missing = SIZES.filter(([, , type]) => !present.has(type));
  if (missing.length > 0) {
    throw new Error(
      `${into} is missing ${missing.map(([points, scale, type]) => `${points}pt@${scale}x (${type})`).join(', ')}`,
    );
  }
  return SIZES.length;
}

/* ---- the bundle ---------------------------------------------------------- */

const bundle = join(HERE, 'target', profile, 'bundle', 'macos', `${productName}.app`);
rmSync(bundle, { recursive: true, force: true });
const contents = join(bundle, 'Contents');
mkdirSync(join(contents, 'MacOS'), { recursive: true });
mkdirSync(join(contents, 'Resources'), { recursive: true });

cpSync(binary, join(contents, 'MacOS', EXECUTABLE));
const sizeCount = icns(join(HERE, 'app', 'icons', 'icon.png'), join(contents, 'Resources', `${productName}.icns`));

/**
 * The keys that have a consequence, and only those.
 *
 * `LSUIElement` is deliberately **absent**. It is what an accessory
 * application sets to stay out of the Dock, and this one decides that at
 * runtime instead — `ActivationPolicy::Regular` while the window is open,
 * `Accessory` while it is not, for the reason in `README.md`. Declaring it here
 * would take the choice away and leave the window with no menu bar.
 */
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>en</string>
\t<key>CFBundleDisplayName</key>
\t<string>${productName}</string>
\t<key>CFBundleExecutable</key>
\t<string>${EXECUTABLE}</string>
\t<key>CFBundleIconFile</key>
\t<string>${productName}.icns</string>
\t<key>CFBundleIdentifier</key>
\t<string>${identifier}</string>
\t<key>CFBundleInfoDictionaryVersion</key>
\t<string>6.0</string>
\t<key>CFBundleName</key>
\t<string>${productName}</string>
\t<key>CFBundlePackageType</key>
\t<string>APPL</string>
\t<key>CFBundleShortVersionString</key>
\t<string>${version}</string>
\t<key>CFBundleVersion</key>
\t<string>${version}</string>
\t<key>LSApplicationCategoryType</key>
\t<string>public.app-category.productivity</string>
\t<key>LSMinimumSystemVersion</key>
\t<string>${minimumSystemVersion}</string>
\t<key>NSHighResolutionCapable</key>
\t<true/>
</dict>
</plist>
`;
writeFileSync(join(contents, 'Info.plist'), plist);
run('plutil', ['-lint', join(contents, 'Info.plist')], { stdio: 'ignore' });

// Ad-hoc, and over the whole bundle rather than the binary alone: that is what
// binds the plist and seals the resources. `--force` because the linker has
// already signed the binary inside.
run('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'ignore' });
run('codesign', ['--verify', '--deep', bundle], { stdio: 'ignore' });

process.stdout.write(`${bundle}\n  ${sizeCount} icon sizes, ad-hoc signed\n`);

/* ---- installing ---------------------------------------------------------- */

if (install) {
  const installed = join(APPLICATIONS, `${productName}.app`);
  // Replaced rather than merged: a copy over the top would leave behind
  // whatever an older bundle had and this one does not.
  rmSync(installed, { recursive: true, force: true });
  cpSync(bundle, installed, { recursive: true });
  process.stdout.write(`${installed}\n`);
}
