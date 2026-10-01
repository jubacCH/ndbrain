//! The Mac client speaks one language too, and `copy.rs` is where it speaks it.
//!
//! `web/test/one-language.test.ts` enforces this for the browser interface, and it
//! walks `web/src` — so this tree was outside it. The failure it guards against is
//! the same one that actually happened there twice: German surviving a translation
//! pass because it sat in markup, where a reviewer reading a diff about layout has
//! no reason to look.
//!
//! Two rules:
//!
//!  - the panel's HTML and JavaScript hold no words a person can read. Every label
//!    is an empty element filled from `copy.rs`, so "every string" is a list
//!    somebody can read in one sitting rather than an archaeology expedition.
//!  - no German anywhere under `src/`, comments included.
//!
//! `copy.rs` is exempt from the second rule for the same reason `copy.ts` is: a
//! line or two of it quotes the vault, which is German, rather than the interface.

use std::path::{Path, PathBuf};

fn here() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(relative: &str) -> String {
    let path = here().join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Words that have actually turned up in this project's German, chosen so no
/// English sentence and no identifier contains one.
const GERMAN: &[&str] = &[
    "anlegen", "auch", "aufgeben", "beim", "benutzername", "diese", "dieser", "durchsuchen",
    "eine", "einen", "entziehen", "erledigt", "freigeben", "freigegeben", "ganzer", "gedanke",
    "geteilt", "keine", "konto", "kontext", "leer", "nachbarn", "nicht", "noch", "oder", "offen",
    "recht", "schon", "und", "unterordnern", "volltext", "weitere", "wichtig", "wurde", "zugriff",
];

/// Whole-word search, so `dir` is a folder and `die` is nothing at all.
fn german_in(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for (number, line) in text.lines().enumerate() {
        let words: Vec<String> = line
            .split(|character: char| !character.is_alphanumeric())
            .map(|word| word.to_lowercase())
            .collect();
        for german in GERMAN {
            if words.iter().any(|word| word == german) {
                found.push(format!("{}: {}", number + 1, line.trim()));
                break;
            }
        }
    }
    found
}

fn sources() -> Vec<(String, String)> {
    let mut out = Vec::new();
    let root = here().join("src");
    walk(&root, &root, &mut out);
    out.sort();
    out
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
    let mut entries: Vec<_> =
        std::fs::read_dir(dir).expect("src/ is readable").filter_map(Result::ok).collect();
    entries.sort_by_key(std::fs::DirEntry::path);
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, root, out);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            let name = path.strip_prefix(root).unwrap().display().to_string();
            out.push((name, std::fs::read_to_string(&path).unwrap()));
        }
    }
}

#[test]
fn holds_no_german_under_src() {
    let mut offences = Vec::new();
    for (name, text) in sources() {
        // See the header: a couple of its lines quote the German vault.
        if name == "copy.rs" {
            continue;
        }
        for offence in german_in(&text) {
            offences.push(format!("{name}:{offence}"));
        }
    }
    assert!(offences.is_empty(), "German under src/:\n{}", offences.join("\n"));
}

/// The panel's markup carries no text node and no readable attribute.
///
/// Checked by what is left after the tags come out, plus the attributes that are
/// invisible on a screenshot and therefore the half nobody reviews: a placeholder
/// and an `aria-label`.
#[test]
fn writes_no_word_a_person_can_read_into_the_panel() {
    let html = read("../ui/capture.html");

    let mut text = String::new();
    let mut inside_tag = false;
    let mut inside_comment = false;
    let mut rest = html.as_str();
    while !rest.is_empty() {
        if inside_comment {
            match rest.find("-->") {
                Some(at) => {
                    rest = &rest[at + 3..];
                    inside_comment = false;
                }
                None => break,
            }
            continue;
        }
        if rest.starts_with("<!--") {
            inside_comment = true;
            rest = &rest[4..];
            continue;
        }
        let character = rest.chars().next().unwrap();
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => text.push(character),
            _ => {}
        }
        rest = &rest[character.len_utf8()..];
    }

    // `ndBrain` is the product's name in `<title>`, which a window manager reads
    // and no translation would touch.
    let left: Vec<&str> = text.split_whitespace().filter(|word| *word != "ndBrain").collect();
    assert!(
        left.is_empty(),
        "capture.html holds text that is not in copy.rs: {left:?}"
    );

    for attribute in ["placeholder=", "aria-label=", "alt=", "title="] {
        assert!(
            !html.contains(attribute),
            "capture.html sets {attribute} itself; that word belongs in copy.rs"
        );
    }
}

/// The panel's script takes its words from `copy.rs` and writes none of its own.
#[test]
fn the_panel_script_writes_no_words_of_its_own() {
    let script = read("../ui/capture.js");

    // Assigning to `textContent` or `placeholder` is how a label is set, and the
    // right-hand side has to come from `copy`, never from a literal here.
    for (number, line) in script.lines().enumerate() {
        let Some(after) = line.split_once("textContent =").or_else(|| line.split_once("placeholder ="))
        else {
            continue;
        };
        let value = after.1.trim();
        assert!(
            value.starts_with("copy.") || value.starts_with("reply.") || value.starts_with("message"),
            "capture.js:{} sets a label from something other than copy.rs: {}",
            number + 1,
            line.trim()
        );
    }

    assert!(german_in(&script).is_empty(), "German in capture.js");
}

/// Every field of `Copy` reaches a person somehow.
///
/// Two routes, because there are two: the panel reads most of them as
/// `copy.<field>`, and a few are sent to it from Rust inside `Reply.message` —
/// `wrong_credentials` is an answer to a request, not a label on the screen.
/// What this refuses is a third case: a label nothing reads at all, which renders
/// as an empty element and looks like a layout bug. It has already caught one.
#[test]
fn the_panel_fills_in_every_label() {
    let copy_source = read("src/copy.rs");
    let readers: String = sources()
        .into_iter()
        .filter(|(name, _)| name != "copy.rs")
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    let script = read("../ui/capture.js");

    // The fields of `pub struct Copy`, read off its declaration.
    let body = copy_source
        .split_once("pub struct Copy {")
        .expect("a Copy struct")
        .1
        .split_once('}')
        .expect("a closing brace")
        .0;

    let mut missing = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        let Some(declaration) = line.strip_prefix("pub ") else { continue };
        let Some((field, _)) = declaration.split_once(':') else { continue };
        let field = field.trim();
        if !script.contains(&format!("copy.{field}")) && !readers.contains(&format!("COPY.{field}")) {
            missing.push(field.to_string());
        }
    }

    assert!(missing.is_empty(), "copy.rs declares labels the panel never shows: {missing:?}");
}

/// Every string `copy.rs` declares on its own reaches a person too.
///
/// `Copy`'s fields are covered above; these are the menu labels and the two
/// built sentences beside them, which no struct holds and which nothing would
/// otherwise notice going unused. It has already caught one: a `MENU_CAPTURE`
/// left behind when that label started carrying the key combination in it.
#[test]
fn leaves_no_menu_label_behind() {
    let copy_source = read("src/copy.rs");
    let readers: String = sources()
        .into_iter()
        .filter(|(name, _)| name != "copy.rs")
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");

    let mut unused = Vec::new();
    for line in copy_source.lines() {
        let line = line.trim();
        // `pub const NAME: &str` and `pub fn name(`.
        let name = line
            .strip_prefix("pub const ")
            .and_then(|rest| rest.split_once(':'))
            .map(|(name, _)| name)
            .or_else(|| {
                line.strip_prefix("pub fn ").and_then(|rest| rest.split_once('('))
                    .map(|(name, _)| name)
            });
        let Some(name) = name else { continue };
        // `COPY` and the `Copy` struct are checked by the test above.
        if name == "COPY" {
            continue;
        }
        if !readers.contains(&format!("copy::{name}")) {
            unused.push(name.to_string());
        }
    }

    assert!(unused.is_empty(), "copy.rs declares text nothing says: {unused:?}");
}

/// The panel can reach the shell at all.
///
/// It is static files with no bundler, so it calls commands through
/// `window.__TAURI__` rather than importing `@tauri-apps/api`. That global is
/// injected only when the configuration asks for it, and it defaults to off — so
/// without this the panel loads, finds nothing, and throws where no part of the
/// interface can say so. Found exactly that way.
#[test]
fn asks_for_the_global_the_panel_calls_through() {
    let script = read("../ui/capture.js");
    let config = read("tauri.conf.json");

    if script.contains("window.__TAURI__") {
        let parsed: serde_json::Value = serde_json::from_str(&config).expect("tauri.conf.json");
        assert_eq!(
            parsed["app"]["withGlobalTauri"],
            serde_json::Value::Bool(true),
            "capture.js calls through window.__TAURI__, which is only injected when \
             app.withGlobalTauri is true"
        );
    }
}
