//! Whether the window is running the bundle the server is serving.
//!
//! The problem this answers is written down in `web/src/build.ts`: ndBrain is a
//! single-page app without a router, so it never navigates, and a window left
//! open goes on running the JavaScript it loaded — across a deploy, with nothing
//! on screen to say so. In a browser tab that is annoying. In a WebView that is
//! never closed it is the normal state of affairs, which is the strongest of the
//! objections against having a WebView at all.
//!
//! The answer is the bundler's own content hash: Vite names the entry module
//! `/assets/index-<hash>.js`, so two pages served at different times either name
//! the same file or do not.

use ndbrain_capture::{bundle_fingerprint, freshness, Freshness};

/// The page as `https://ndbrain.b8n.ch/` actually serves it, cut to the tags
/// that matter. The entry module is content-hashed; the preload and the
/// stylesheet are not read, because one name is enough and the entry is the one
/// that changes whenever any code does.
const SERVED: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <title>ndBrain</title>
    <script>
      (function () { /* the theme bootstrap */ })();
    </script>
    <script type="module" crossorigin src="/assets/index-Dw9DyPbP.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/dist-D7TjKvnp.js">
    <link rel="stylesheet" crossorigin href="/assets/index-CubzgS_Q.css">
  </head>
  <body><div id="root"></div></body>
</html>
"#;

#[test]
fn names_the_entry_module_the_page_loads() {
    assert_eq!(bundle_fingerprint(SERVED).as_deref(), Some("/assets/index-Dw9DyPbP.js"));
}

/// The inline theme bootstrap comes first in the real page and carries no `src`.
/// A reader that took the first `<script>` would find nothing and report every
/// deploy as unknown, which is the failure that looks like the check working.
#[test]
fn is_not_fooled_by_the_inline_script_in_front_of_it() {
    assert!(SERVED.find("<script>").unwrap() < SERVED.find("src=").unwrap());
    assert!(bundle_fingerprint(SERVED).is_some());
}

/// `vite dev` serves `/src/main.tsx` unhashed. That is a real answer, not a
/// missing one: the name never changes, so nothing is ever reported stale, which
/// is correct for a bundle nobody built.
#[test]
fn reads_the_unhashed_name_a_dev_server_serves() {
    let dev = r#"<script type="module" src="/src/main.tsx"></script>"#;
    assert_eq!(bundle_fingerprint(dev).as_deref(), Some("/src/main.tsx"));
}

/// A reply that is not the page at all — a proxy's error sheet, an empty body,
/// a JSON 404 — has no fingerprint, and that must read as `None` rather than as
/// some string that happens to differ from the last one.
#[test]
fn finds_nothing_in_something_that_is_not_the_page() {
    for not_the_page in ["", "<html><body>nothing here</body></html>", r#"{"code":"not_found"}"#] {
        assert_eq!(bundle_fingerprint(not_the_page), None, "{not_the_page}");
    }
}

/// A `<script type="module">` with its code inline has no `src`, and reading one
/// as a fingerprint would compare the bootstrap's text against itself forever.
#[test]
fn ignores_a_module_script_that_carries_its_code_inline() {
    assert_eq!(bundle_fingerprint(r#"<script type="module">import "./x";</script>"#), None);
}

/// Nothing to compare is `Unknown`, and `Unknown` must never reload.
///
/// This is the half that would do damage: a reload fired on a failed fetch would
/// throw away whatever somebody was typing every time the network blinked.
#[test]
fn says_nothing_when_either_side_is_unknown() {
    assert_eq!(freshness(None, Some("/assets/index-a.js")), Freshness::Unknown);
    assert_eq!(freshness(Some("/assets/index-a.js"), None), Freshness::Unknown);
    assert_eq!(freshness(None, None), Freshness::Unknown);
}

#[test]
fn is_current_while_the_names_agree() {
    assert_eq!(
        freshness(Some("/assets/index-a.js"), Some("/assets/index-a.js")),
        Freshness::Current
    );
}

#[test]
fn is_stale_only_once_the_server_serves_a_different_name() {
    assert_eq!(
        freshness(Some("/assets/index-a.js"), Some("/assets/index-b.js")),
        Freshness::Stale
    );
}

/// Only `Stale` may cause a reload, and this is the list of what does not.
#[test]
fn reloads_for_nothing_but_a_confirmed_difference() {
    assert!(Freshness::Stale.asks_for_a_reload());
    assert!(!Freshness::Current.asks_for_a_reload());
    assert!(!Freshness::Unknown.asks_for_a_reload());
}

/// `src` has to be the whole attribute name.
///
/// Vite writes `crossorigin src="…"`, and anything matching on the three letters
/// alone reads a neighbouring attribute's value — which is a string, so it looks
/// like an answer rather than a failure.
#[test]
fn reads_the_src_attribute_and_not_one_whose_name_ends_in_it() {
    let tag = r#"<script type="module" data-src="/wrong.js" src="/assets/index-a.js"></script>"#;
    assert_eq!(bundle_fingerprint(tag).as_deref(), Some("/assets/index-a.js"));
}

/// One tag's attributes, not everything after it.
///
/// The real page opens with an inline `<script>` and the entry module comes
/// later, with other tags in between. A reader that did not stop at the closing
/// bracket would answer with the first `src` anywhere on the page — a plausible
/// looking string from an element that has nothing to do with the bundle.
#[test]
fn reads_only_the_attributes_of_the_tag_it_is_looking_at() {
    let page = concat!(
        "<script>var theme = 1;</script>",
        r#"<img src="/favicon-32.png">"#,
        r#"<script type="module" src="/assets/index-a.js"></script>"#,
    );
    assert_eq!(bundle_fingerprint(page).as_deref(), Some("/assets/index-a.js"));
}
