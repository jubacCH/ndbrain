# docs

**`install/`** — what somebody needs to run ndBrain. [`compose.yaml`](install/compose.yaml)
is the published image with sensible defaults; the quick start in the main
[README](../README.md) is four lines around it.

**`superpowers/`** — the design documents and implementation plans for the
larger pieces, kept as they were written rather than tidied afterwards. The
directory is named after the tooling they were written with, which means nothing
to a reader; the contents are ordinary engineering records.

They are here because the commit messages in this project carry the *why* of
each change, and these carry the *why* of each shape — the alternative that was
rejected, the constraint that forced a design, the thing that turned out to be
wrong between the plan and the code. Where an implementation departed from its
plan, the plan says so rather than being quietly corrected.

They are not documentation of how ndBrain works today. For that, the
architecture section of the main README is current and these are not.
