# Copywriting

This guide sets how Bowerbird's copy reads. `CLAUDE.md` covers where the words go
(`foo.strings.ts`, whole sentences, 1 message stated once). Here, "copy" is all the text a
reader sees, and a "string" is 1 piece of it.

## The 5 rules

1. **Use fewer words.** Write short sentences and simple words. Drop "quite", "very",
   "really", "simply", "easily", "just".
2. **Use sentence case everywhere.** Headings, buttons, labels, tabs, and menu items all take
   sentence case. Proper nouns and the capitalised terms in the [glossary](#glossary) keep
   their capitals, and nothing else does.
3. **Talk to the reader.** Write "you" and "your". Write "we" only when Bowerbird itself did
   or will do something.
4. **Lead with the verb.** Buttons, steps, and feature descriptions start with what happens.
5. **Keep the reader calm.** Name what went wrong and what to do. Never blame the reader, and
   never use an exclamation mark.

## Voice

Every string states a fact or names an action.

- **Use contractions.** Write "you're", "we'll", "can't", "doesn't". "We'll look for photos in
  this folder and any inside it."
- **No jokes or colloquialisms.** "Oops" on a failed export tells the reader the failure is
  funny. Describe the failure.
- **Reassure with a fact.** "Your edits are in the catalogue." tells the reader something.
  "Don't worry" tells them there was something to worry about.
- **Use only words the reader knows, plus the glossary.** A photographer knows *exposure*,
  *white balance*, *RAW*, *crop*, *HDR*. The [glossary](#glossary) holds the few Bowerbird
  words they learn from the app. They don't know *replication*, *peer*, *prepared frame*,
  *assembly*, or *collapse stamp*. Internal names stay in the code. Write so a child or a
  grandparent could follow it.

## Length by type

| Copy | Length | Example |
|---|---|---|
| Button or link | 1 to 3 words, verb and object | "Add library", "Merge photos", "Show less" |
| Navigation link to a page | the page's name | "Home", "Features", "Settings" |
| Page subtitle or meta description | 1 phrase, no full stop | "A free, fast tool for triaging RAW photos" |
| Item in a "coming soon" list | the feature's name, no full stop | "Exposure and focus bracket merging" |
| Menu item, tab, label | 1 to 3 words | "Keyboard shortcuts", "Hide sidebar", "White balance" |
| Heading | 1 to 4 words | "Dust removal", "Synced devices" |
| Tooltip or helper text | 1 clause | "Rating from 0 to 5" |
| Toast or status | 1 sentence | "All changes saved." |
| Error or validation | 1 or 2 sentences, what happened then what to do | "This folder has moved. Choose where it is now." |
| Empty state | a headline, 1 or 2 sentences, 1 button | "No photos yet" / "Add a folder of photos to start." / "Add library" |
| Step in instructions | 1 imperative clause | "From the toolbar, select **Crop**." |

In the app, aim for 10 words or fewer per string. An obvious label gets no sublabel. Ranges
and units go on the field as its min, max, and suffix, and stay out of the label.

### The sublabel is the default that has to be argued for

Writing copy makes it tempting to explain, and the explanation lands under the control as a
sublabel: what the field is for, what happens if you tick it, what we do with it afterwards.
Each line reads as helpful on its own. A screen of them reads as a form that does not trust
the reader, and the words that matter, the label and the button, are buried among words that
do not.

**So a sublabel starts out unjustified.** Write the label, then ask what a reader would get
wrong with no sublabel at all. Nothing? Then there is no sublabel. These all shipped in a
review and all came out again:

| Cut | Why it went |
|---|---|
| **Your email** / "We'll reply here if we need more detail." | Everybody knows what an email field in a form is for. |
| **Strip identifying EXIF data** / "We remove your name and where the photo was taken, and keep the camera settings." | The label says it. The sentence restates it at three times the length. |
| **Include current photo in report** / "The photo, its renders, and what we measured about it." | Nobody ticking this wants the manifest. |

**A sublabel earns its place when the reader cannot see the consequence**, and then it names
that consequence and stops: a control that deletes something, costs money, or sends data
somewhere they would not expect. One line, on the one control that needs it; if two controls
on a screen both have one, at least one of them is explaining itself for nothing.

## Buttons and actions

- **Put the verb first and name the object.** Write "Export photo" when there's more than 1
  thing to export, since "Export" alone doesn't say which. "OK" and "Submit" never label an
  action that has a name.
- **Make the button match its heading.** A dialog titled "Delete 3 photos?" has a button
  reading "Delete".
- **Call each action by 1 name.** A tool called "Crop" in the toolbar, "Crop & rotate" in a
  menu, and "Cropping" in a tooltip reads as 3 tools. Choose 1 name and reuse the string.
- **Make a link say where it goes.** "Learn more" works only when the sentence around it
  already names the subject.

## Headings and feature names

- **1 phrase, sentence case, no full stop.** A heading is never 2 fragments.
- **Name the feature plainly and objectively.** Say what it is, and leave out what the reader
  might want it for. "Dust removal" is the name. "Clean up your sensor" guesses at an intent.
- **Describe a feature with a present-tense verb and no subject.** In a feature list, the
  feature is the implied subject, so start with what it does: "Groups similar photos into 1
  thumbnail", "Imports around 50 photos a second", "Makes triage faster". Writing
  "Bowerbird" at the start of every item repeats it for no gain. Avoid the imperative
  ("Group similar photos into 1 thumbnail"), which tells the reader to do the job the
  feature does. No full stop.
- **Ask a question only when it's the real question.** "Delete 3 photos?" asks for a decision.
  Help questions use the reader's first person: "How do I undo an edit?"

## Errors, warnings, and empty states

1. **Say what went wrong, as specifically as helps.** "Something went wrong" says too little
   and "SQLITE_BUSY" says too much. When the cause is unknown, say what is known: "We couldn't
   load this photo."
2. **Say what to do next.** "Try again in a moment." "Check the drive is connected."
3. **Describe, and leave blame out.** Write "We couldn't find that folder. Check the path?"
   and avoid "Invalid path". Headlines avoid "error", "problem", "invalid", and "failed" when
   a plain description exists.
4. **Prevent it first.** An error message is a last resort. When an action can't succeed,
   disable it and say why beside it.
5. **No exclamation marks.** They make a message read as alarming or flippant.

The order is what happened, then why if it's known and useful, then what to do.

- "We couldn't open this RAW file. Your camera may be too new for this version."
- "We couldn't reach the other device. Check it's on the same network."

**The component shows the severity.** Info is neutral, success confirms, a warning means
something went wrong and the reader can carry on, and an error blocks them or is about to lose
data. Keep the words calm at every level.

**An empty state** has a headline naming what's empty, 1 or 2 sentences on how to fill it,
and 1 primary action. It needs no illustration.

**A toast** is 1 sentence. Skip the toast when the UI already changed visibly.

## Limitations and "not yet"

State the limit as a fact about the feature, then say what the reader can do instead.

- "Panoramas aren't available on mobile."
- "HDR export isn't supported for JPEG yet. Export AVIF to keep the HDR."
- "You can merge up to 12 photos at a time."

"Yet" and "currently" are fine when true. Never promise a date.

## Instructions and help text

- **1 action per step.** Each step is imperative and ends in a full stop. "Select the photo
  you want to edit."
- **Say where to look before what to do.** "From the toolbar, select **Crop**."
- **Write UI names in bold, exactly as they appear in the UI,** with no quotes around them.
  Text the reader types goes in italics, as in *Holiday 2026*.
- **Use "select" as the verb.** It works on every device. Use "click" and "hover" only in
  desktop-only text, and "tap" only in touch-only text.
- **Name the key, then the platform in parentheses.** "Command + Z (Mac) or Ctrl + Z
  (Windows)". A shortcut sheet can use symbols alone.
- **Say what the reader sees after the step.** "The photo moves to the Bin."

## Banned structures

These read as written by a machine or a marketer. None of them appear in copy.

- **Correction framing.** "X, never Y", "X, not Y", "Not X. Y.", "X rather than Y", "X
  instead of Y". The reader never assumed Y, so state X. Write "Bowerbird saves edits to the
  catalogue." Avoid "Bowerbird saves edits to the catalogue, never to the RAW."
- **"Not just X, but Y."** State Y.
- **Stacked fragments.** "Every photo. One place." "Fast. Private. Yours." Write 1 sentence.
- **Caption fragments.** A noun, a comma, then a participle: "Similar photos, grouped into 1
  thumbnail", "Your camera's colours, matched for you", "Spots from sensor dust, found and
  removed". Each is a passive with its verb taken out, and a run of them reads as a template.
  Lead with the verb: "Groups similar photos into 1 thumbnail".
- **Question, then answer.** "Shot a burst? Keep the sharpest frame." "No signal? No problem."
  Write the statement.
- **"No X required."** "No account required." Say what the reader can do: "You can use
  Bowerbird without an account."
- **Forced threes.** "Sort, edit, and share" when the point was 1 thing. List the items that
  exist, however many there are.
- **Superficial -ing tails.** "…, making it easy to find your best shots." Delete the tail or
  make it its own sentence with a real claim.
- **False ranges.** "Everything from snapshots to landscapes." Name the things, or cut it.
- **Synonym cycling.** "Photo", "image", "shot", and "picture" for 1 thing on 1 screen.
  Choose 1 and repeat it.
- **Chatbot and cheer phrases.** "Great!", "All set!", "You're all done!", "Let's get
  started", "Happy editing".

## Word choice

- **Say what it does.** "Your edits stay safe" names a feeling. "Bowerbird never writes to
  your originals" names the mechanism. A sentence that could appear unchanged in another app
  says nothing about this one. Cut it.
- **Plain words.** "use" for "utilize" and "leverage", "help" for "facilitate", "many" for
  "numerous", "if" for "in the event that", "to" for "in order to", "because" for "due to the
  fact that".
- **"Is" and "has".** Avoid "serves as", "stands as", "boasts", "features", "offers".
- **Active voice.** Write "Bowerbird exports the photo". Avoid "The photo is exported".
  Passive is fine only when the actor doesn't matter.
- **Strong verbs over adverbs.** Cut "quickly", "easily", "seamlessly", "instantly". Give the
  number if speed matters.
- **Literal words.** No metaphors, personified software ("the editor wants a photo"), or
  figurative verbs ("rides along", "unlocks").
- **Hedge once at most.** "May" is the most hedging a sentence gets. "Could potentially" and
  "might possibly" become "may".
- **Banned vocabulary.** Additionally, crucial, delve, enhance, elevate, empower, fostering,
  garner, intricate, landscape, leverage, magic, pivotal, powerful, robust, seamless,
  showcase, streamline, supercharge, unlock, vibrant. Say what the thing does.
- **Whole sentences in prose.** A label can be a fragment. A sentence keeps its articles and
  its verb, with no arrows or abbreviations the reader has to decode.

## Mechanics

- **British/Australian spelling**, matching the strings already in `web/src` ("colour",
  "catalogue", "analyse"). The app uses 1 locale and never mixes 2.
- **The Oxford comma**, every time: "photos, videos, and panoramas".
- **No dashes as punctuation.** No em dashes, no en dashes, and no hyphen standing in for
  either. End the sentence or use a comma. Ranges in prose are "0 to 5". A shortcut sheet can
  show "0–5".
- **Colons only before a list or an example**, never to join 2 halves of a sentence.
- **Full stops** go on sentences, steps, errors, and toasts. Headings, buttons, labels, list
  fragments, and 1-clause tooltips take none. Decide by what the string is, and ignore where
  it sits. Alt text such as "The grid on a phone" and a feature description such as "Groups
  similar photos into 1 thumbnail" are fragments and take none. Body text such as "Open a
  stack, and its photos appear in a row below." is a sentence and takes one.
- **Strings shown side by side share 1 shape.** A row of cards, a list, or a set of tabs is
  all sentences or all fragments. 5 sentences and 3 fragments in 1 grid read as 2 authors.
- **Straight apostrophes and quotes**, as nearly every string in `web/src` already has them.
- **Numerals for every number.** "3 photos", "up to 50 photos". Units take a space and a
  standard symbol, as in "9 MB", "40 × 40 px", "1:1". Multipliers are "2×".
- **File types in capitals with no dot.** RAW, DNG, JPEG, AVIF, HEIC, JXL, PDF.
- **Capitals for proper nouns and named features only.** Bowerbird is a proper noun. A named
  feature is a glossary term whose lower-case word would read as the generic thing, as in
  "Move to Bin". Generic features stay lower case, as in "crop", "white balance", "catalogue".
- **Dates** read "18 September 2026".
- **No URLs** in copy. Link the words instead.
- **No emoji** in copy.
- **Bold** marks a UI name in help text and nothing else.

## Glossary

Each concept gets 1 word. When a string uses any word in the "Avoid" column for the concept on
its row, change it to the term.

A term written with a capital is a named feature, and keeps its capital everywhere, mid-sentence
included: "Deleted photos move to the Bin." It gets one because the lower-case word reads as
something generic. A generic bin, the verb "pick", a light, and a stack being triaged all
exist in ordinary sentences, and the capital marks the Bowerbird thing. Every other term is
lower case except at the start of a string.

### The library

| Term | What it is | Avoid |
|---|---|---|
| photo | 1 entry in the library, with its RAW, edits, rating, and notes | photograph, picture, image, shot, item |
| library | A folder of photos that Bowerbird catalogues | collection, project, workspace |
| library root | The folder on disk a library starts at | root path, base folder |
| catalogue | Everything Bowerbird records about a library's photos, apart from the files themselves | database, index |
| shoot | A folder inside a library, holding the photos from 1 outing | folder (in the app), event, session, roll |
| album | A set of photos you choose, from any shoots and libraries | collection, set, gallery |
| stack | Similar photos grouped so they show as 1 | group, burst, cluster |
| unstack | Split a stack back into single photos | ungroup |
| original | The RAW file as the camera wrote it | source, master, negative |
| local copy | An original stored on this device | cached copy, download |
| embedded JPEG | The JPEG the camera stored inside the RAW | camera JPEG, preview JPEG |
| Bin | Where deleted photos go before their files leave the disk | trash, recycle bin, deleted |
| hide | Take a shoot out of view without deleting it | archive, collapse |
| read-only | A library Bowerbird never changes on disk | locked, protected |

### Judging photos

| Term | What it is | Avoid |
|---|---|---|
| rating | 0 to 5 stars | score, stars (as the name) |
| unrated | A rating of 0 | no rating, 0 stars |
| triage | Deciding which photos to keep | culling, review, sorting |
| Pick | The verdict to keep a photo | keep, select, favourite, flag |
| Reject | The verdict to drop a photo | discard, cull, dislike |
| Undecided | Neither a Pick nor a Reject | untriaged, unjudged |
| verdict | Pick, Reject, or Undecided | decision, status |
| Triage stack | Going through a stack 2 photos at a time and choosing between them | compare, battle, head to head |
| round | 1 choice between 2 photos in a Triage stack | step, match |

### Viewing

| Term | What it is | Avoid |
|---|---|---|
| grid | The page of thumbnails | gallery, browser, contact sheet |
| thumbnail | A photo's small picture in the grid, or the one chosen to represent a shoot or album | grid tile, tile, cover, preview |
| photo viewer | The full-screen view of 1 photo | photo view, lightbox, detail view |
| filmstrip | The row of thumbnails along the photo viewer | strip, carousel |
| rendition | A photo drawn from its RAW at a set size and quality, for the grid or the photo viewer | render (as a noun), preview, derivative |
| loupe | The magnifier over part of the photo in the editor | magnifier, zoom lens |
| sidebar | The panel of libraries, shoots, and albums down the side | rail, drawer, nav |

### Editing and making photos

| Term | What it is | Avoid |
|---|---|---|
| edit | A change to how a photo looks, made in the editor | adjustment, develop, tweak |
| Light, White balance, Colour, Effects, Detail, Dust removal, Geometry | The sections of the edit panel, written as the UI shows them when named as a section | tabs, groups, panels |
| crop, straighten, perspective | Geometry tools | trim, level, keystone |
| guide | A line drawn to straighten or correct perspective against | helper line |
| dust removal | Removing spots left by sensor dust | spot healing, clean up |
| colour fringe removal | Removing purple and green rims along hard edges | defringe, chromatic aberration, CA |
| soft proof | Showing the photo as it looks in HDR, in sRGB or printed | preview, simulate, mockup |
| merge | Combining several photos into 1 | composite, stitch, combine, assembly |
| panorama | A merge of frames side by side into 1 wider photo | pano, stitch |
| Take best parts | A merge that builds 1 photo from the best part of each frame | composite, blend, best take |
| frame | 1 of the photos going into a merge | source, input, layer |
| export | Writing photos out as files in a chosen format | render, save as, output |
| HDR, SDR | High and standard dynamic range. Write the abbreviation | high dynamic range (in labels) |

### Devices

| Term | What it is | Avoid |
|---|---|---|
| device | A computer or phone running Bowerbird | peer, node, host, the other Bowerbird |
| sync | Keeping a library's catalogue, and optionally its originals, the same on 2 devices | replicate, mirror |
| synced devices | The devices a library syncs with | peers, replicas |
| pair | Connecting a new device so a library can sync to it | link, join |
| fetch | Copying an original from another device to this one | pull, download (for device transfers) |
| send | Copying an original from this device to another | push, upload |
| scan | Bowerbird reading a library's folders for added, moved, changed, or removed files | sync, index, refresh, reconcile |
| backup | A folder, drive, or share every original is copied to | mirror, vault, archive, passive peer |
| storage limit | What a library's originals may take up on this device before the oldest local copies go | quota, budget, cap |

## Checklist

Before a string ships, check each of these:

- [ ] Could it lose a word? Try deleting each one.
- [ ] Is it in sentence case, with the verb first if it's an action?
- [ ] Would a photographer who has never seen the code understand every word?
- [ ] If it's an error, does it say what happened and what to do, with no blame and no "!"?
- [ ] Does it use the glossary's term for every concept it names?
- [ ] If it describes a feature, does it start with a present-tense verb and no subject?
- [ ] Is it a sentence or a fragment, and does its full stop match? Do the strings beside it
      have the same shape?
- [ ] Is it free of every banned structure and word above?
- [ ] Are the spelling, numerals, units, and punctuation right?
