# x86 Midterm Prep

Practice for CIS 231 chapters 4, 6, and 7 (Irvine32, 32-bit MASM). Plain HTML, CSS, and JS with no build step, plus a small Node server that saves stats to a file.

- **Trace**: endless generated snippets. For up to two marked lines, give the registers and flags. After checking, reveal the registers and flags after every line.
- **Concepts**: a fixed bank of about 180 multiple choice, true/false, and fill-in questions keyed to textbook sections.
- **Mixed**: both.

Topics you miss come up more often. Stats, chapter filters, and unchecked topics are saved to `stats.json` (gitignored).

## Layout

- `js/x86.js`: emulator for the instruction subset (parses MASM syntax, tracks known bits and undefined flags)
- `js/generators.js`: trace question generators, one per topic
- `js/concepts.js`: concept bank
- `js/app.js`, `css/style.css`, `index.html`: UI
- `server.js`: serves the app on 127.0.0.1 and reads/writes `stats.json`

## Commands

Start the server, then open http://localhost:8231:

```
node server.js
```

`PORT=8232 node server.js` uses another port. Opening `index.html` directly also works, but stats then live only in browser storage.

Unit tests:

```
node --test test/*.test.js
```

Differential test against the real CPU. It needs the `irvine` script (JWasm, JWlink, Irvine32, Wine) on `PATH`:

```
node test/difftest.js 100
```

It assembles 100 random questions per topic, runs them with `DumpRegs` after every instruction, and compares each register and flag the emulator considers defined.
