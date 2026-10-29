# Revisions and Comments — XML details

Deep reference for `docx_revisions.py` and `docx_comments.py`. Read this
when you need to reason about the raw WordprocessingML, extend the
scripts, or debug an unusual document. Everyday use only needs SKILL.md.

## Reading tracked documents

`docx_read.py FILE --text --mode final` resolves revisions in an in-memory
package and returns the accepted text. `--mode original` reconstructs the
pre-revision view. `--mode markup` returns both under `final` and `original`,
together with `revisions.records` anchored to the original package's XML.
The modes also apply to `--structure` and `--styles`; reading never rewrites
the input file.

The legacy `body`, `tables`, `headers` and `footers` fields remain available.
Use `blocks` to retain paragraph/table order and nested cell blocks. Table
cells report `gridSpan` and `verticalMerge`. Related content is exposed as
`headerStories`, `footerStories`, `footnotes`, `endnotes`, `comments` and
`textboxes`; note references retain their IDs. Section records identify all
default/first/even header/footer references and inherited references. Linked
stories are emitted once, with their section uses listed. Text-box fallback
representations are deduplicated. These are text/structure views, not layout
renderings or a field recalculation engine.

Each revision record includes `part`, original XML `path`, `id`, `element`,
`type`, `scope`, author/date and text. Context includes the containing
paragraph/cell/row path and text; property revisions include previous/current
property XML and revision attributes. `type` retains `insertion`/`deletion`
for the original two revision kinds; `element` always names the OOXML element.
IDs can repeat between package parts. `docx_revisions.py accept|reject --id N
--part word/header1.xml` targets a particular part; omitting `--part` resolves
all matching IDs. `accept-all`/`reject-all` use the same projection engine as
reading and preserve other package entries, including unknown parts.

## Tracked-change XML

Word records run-level tracked changes as wrapper elements inside a
paragraph (`w:p`), in the `w` namespace
`http://schemas.openxmlformats.org/wordprocessingml/2006/main`:

```xml
<w:p>
  <w:r><w:t>Base </w:t></w:r>
  <w:ins w:id="1" w:author="Editor" w:date="2026-01-02T03:04:05Z">
    <w:r><w:t>inserted text</w:t></w:r>
  </w:ins>
  <w:del w:id="2" w:author="Editor" w:date="2026-01-02T03:04:05Z">
    <w:r><w:delText>deleted text</w:delText></w:r>
  </w:del>
</w:p>
```

Key facts the script relies on:

- Deleted text lives in `w:delText`, not `w:t`. A python-docx paragraph's
  plain `.text` also omits runs inside revision wrappers, including inserted
  text, so it is not an accepted-view reader. Projection resolves wrappers
  before extracting text.
- Resolution semantics:
  - accept `w:ins` → unwrap (move child runs up, drop the wrapper)
  - reject `w:ins` → remove the wrapper and its contents
  - accept `w:del` → remove the wrapper and its contents
  - reject `w:del` → rename each `w:delText` to `w:t`, then unwrap
- `moveFrom`/`moveTo` follow deletion/insertion semantics. Move range and
  custom-XML range markers describe boundaries or markup changes; they do
  not independently delete all text between the markers.
- A deleted paragraph mark joins its paragraph to the following paragraph
  in the final view. Rejecting an inserted paragraph mark joins the original
  view. Paragraph text remains, and the surviving mark supplies properties.
- `trPr/ins|del` applies to a whole row; `cellIns|cellDel` applies to a cell.
  `cellMerge` restores the appropriate current/original vertical-merge state.
- Property-change records restore the contained prior property snapshot for
  original reads, or retain current properties for final reads. This includes
  run/paragraph/row/cell/table/table-grid/section properties. Section snapshots
  can change which header/footer stories belong to the original document.
- `numberingChange` is included in revision metadata; original LISTNUM field
  caches use its recorded original display value. Ordinary field caches are
  read as stored, without invoking Word or changing calculation state.
- Projection visits every Word XML package part, including body, nested table
  cells, content controls, headers/footers, notes, comments and text boxes.

OOXML semantics follow Microsoft's documentation on
[paragraph marks and property snapshots](https://learn.microsoft.com/en-us/office/open-xml/word/how-to-accept-all-revisions-in-a-word-processing-document),
[cell merge revisions](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.cellmerge),
and [numbering changes](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.numberingchange).

## Comments

Three cooperating pieces:

1. **`word/comments.xml`** — one `w:comment` element per comment,
   carrying `w:id`, `w:author`, `w:initials`, `w:date`, and body
   paragraphs. Related from document.xml via the relationship type
   `.../comments` and content type
   `application/vnd...wordprocessingml.comments+xml` (also needs a
   `[Content_Types].xml` override — python-docx's part machinery adds it
   when the part is registered).
2. **Range markers in the story** — `w:commentRangeStart w:id="N"`
   before the anchored runs, `w:commentRangeEnd w:id="N"` after them.
3. **The reference run** — a `w:r` containing `w:commentReference
   w:id="N"`, placed right after the range end; it ties the balloon to
   the location.

`docx_comments.py` behavior:

- **list / delete** always work at the XML level, so they handle files
  from any producer. `anchored_text` is reconstructed by walking each
  part root in document order and collecting `w:t` text between the
  start and end markers for each id.
- **add** first isolates the target text into whole runs. If the match
  starts or ends mid-run, the run is split at the boundary (the split
  copies `w:rPr`, so formatting is preserved). Then:
  - python-docx >= 1.2: the native `document.add_comment(runs, ...)`
    API is used (it creates the comments part, markers, and reference
    run itself).
  - older versions or `--xml`: the script builds `word/comments.xml`,
    registers the part + relationship through the opc layer, and
    inserts the markers/reference manually.
- Deleting a comment removes the `w:comment` element and all three
  marker kinds for that id; the anchored document text is untouched.

Modern Word also writes `commentsExtended.xml` (threading/resolved
state). The scripts neither read nor produce it: replies and "resolved"
flags are invisible here, and comments added by this skill are plain
top-level comments.
