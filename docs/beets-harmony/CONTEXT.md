# Beets Harmony

Beets Harmony assists an active beets album import when MusicBrainz does not yet contain the release. It identifies the corresponding Spotify release, hands it off for MusicBrainz entry, and returns the resulting release to the same import.

## Language

**Source Album**:
The album currently being processed by beets, represented by its files and available metadata.
_Avoid_: Import directory, unmatched folder

**Edition Identity**:
The release-level facts that distinguish one issue of an album from another, including medium, track structure, edition markers, date, territory, and identifiers.
_Avoid_: Album identity, version

**Spotify Candidate**:
A Spotify release that might correspond to the Source Album.
_Avoid_: Search result, match

**Selected Spotify Release**:
The Spotify Candidate accepted as the same edition as the Source Album.
_Avoid_: Winning result, best guess

**Exact Match**:
A Spotify Candidate for which all available edition evidence agrees with the Source Album, no evidence conflicts, and no competing candidate is similarly plausible.
_Avoid_: Close match, likely match

**Ambiguous Match**:
A set of plausible Spotify Candidates for which edition identity cannot be established automatically.
_Avoid_: Failed match, bad results

**Match Evidence**:
The Source Album facts used to distinguish an edition, including credits, titles, ordering, durations, media structure, and edition markers.
_Avoid_: Score inputs, metadata quality

**Discovery Metadata**:
Spotify data used to identify an edition and prepare a Harmony Handoff, but never selected as the metadata applied by beets.
_Avoid_: Import metadata, Spotify tags

**Import Metadata**:
MusicBrainz data selected by beets for the Source Album after a release match becomes available; it is the mandatory metadata authority for a completed assisted import.
_Avoid_: Discovery metadata, seed data

**Harmony Handoff**:
The transition from a Selected Spotify Release to Harmony for preparation of a MusicBrainz release.
_Avoid_: Submission, import

**Release Seed**:
Release metadata loaded into the MusicBrainz release editor but not yet submitted to the database.
_Avoid_: Draft release, submitted release

**Submitted Release**:
A MusicBrainz release created from a Release Seed and assigned an MBID.
_Avoid_: Seed, candidate

**Linked Release**:
An existing MusicBrainz release whose relationships identify the Selected Spotify Release as the same edition.
_Avoid_: Search result, probable duplicate

**Import Resumption**:
Continuation of the same active beets import after its Submitted Release becomes available for matching.
_Avoid_: Re-import, second import
