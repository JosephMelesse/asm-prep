/* UI: trace questions from the generators, concept questions from the bank. */
(function () {
  'use strict';

  const { TOPICS } = window.Generators;
  const { BANK } = window.Concepts;
  const ASK_FLAGS = ['CF', 'ZF', 'SF', 'OF'];

  // ------------------------------------------------------------ storage

  // Saved to stats.json when served by server.js; otherwise browser storage.
  const persist = {
    remote: false,
    async load() {
      if (location.protocol.startsWith('http')) {
        try {
          const r = await fetch('api/stats', { cache: 'no-store' });
          if (r.ok) {
            this.remote = true;
            return await r.json();
          }
        } catch (e) { /* not served by server.js */ }
      }
      try {
        return JSON.parse(localStorage.getItem('x86prep') || '{}');
      } catch (e) {
        return {};
      }
    },
    save(data) {
      const body = JSON.stringify(data);
      if (!this.remote) {
        try {
          localStorage.setItem('x86prep', body);
        } catch (e) { /* storage blocked: keep going without it */ }
        return;
      }
      fetch('api/stats', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
        .then((r) => setStatus(r.ok ? 'saved' : 'failed'), () => setStatus('failed'));
    },
  };

  const state = {
    mode: 'trace',
    chapters: new Set([4, 6, 7]),
    disabled: new Set(),
    stats: {},
    session: { right: 0, total: 0 },
    queue: [],
    current: null,
  };

  function save() {
    persist.save({
      mode: state.mode,
      chapters: [...state.chapters],
      disabled: [...state.disabled],
      stats: state.stats,
    });
  }

  function restore(saved) {
    if (['trace', 'concept', 'mixed'].includes(saved.mode)) state.mode = saved.mode;
    if (Array.isArray(saved.chapters)) state.chapters = new Set(saved.chapters);
    if (Array.isArray(saved.disabled)) state.disabled = new Set(saved.disabled);
    if (saved.stats && typeof saved.stats === 'object') state.stats = saved.stats;
  }

  const STATUS = {
    saved: ['', 'Stats are saved to stats.json.'],
    failed: ['warn', 'Could not save stats. Is node server.js still running?'],
    local: ['warn', 'Stats are only kept in this browser. To save them to stats.json, run node server.js and open http://localhost:8231.'],
  };

  function setStatus(kind) {
    const node = document.querySelector('#saveStatus');
    node.className = 'hint ' + STATUS[kind][0];
    node.textContent = STATUS[kind][1];
  }

  function record(key, ok) {
    const s = state.stats[key] || { right: 0, total: 0 };
    s.total++;
    if (ok) s.right++;
    state.stats[key] = s;
    save();
    state.session.total++;
    if (ok) state.session.right++;
    $('#score').textContent = state.session.right + ' / ' + state.session.total;
  }

  // ------------------------------------------------------------ dom helpers

  const $ = (sel) => document.querySelector(sel);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rich = (s) => escapeHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>');

  const shuffle = (a) => {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  };

  // ------------------------------------------------------------ choosing questions

  function missWeight(key) {
    const s = state.stats[key];
    if (!s || !s.total) return 1.5;
    return 1 + 3 * ((s.total - s.right) / s.total);
  }

  function weightedPick(items, weight) {
    const ws = items.map(weight);
    let r = Math.random() * ws.reduce((a, b) => a + b, 0);
    for (let i = 0; i < items.length; i++) {
      r -= ws[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  const activeTopics = () => TOPICS.filter((t) => state.chapters.has(t.ch) && !state.disabled.has(t.id));
  const activeConcepts = () => BANK.filter((q) => state.chapters.has(q.ch));

  function nextTrace() {
    const topics = activeTopics();
    if (!topics.length) return null;
    const topic = weightedPick(topics, (t) => missWeight('t:' + t.id));
    for (let i = 0; i < 50; i++) {
      const q = topic.gen();
      try {
        const res = window.X86.run({ data: q.data || [], code: q.code });
        return { kind: 'trace', topic, q, res };
      } catch (e) {
        if (!(e instanceof window.X86.AsmError)) throw e;
      }
    }
    return null;
  }

  function nextConcept() {
    const pool = activeConcepts();
    if (!pool.length) return null;
    const ids = new Set(pool.map((q) => q.id));
    state.queue = state.queue.filter((id) => ids.has(id));
    if (!state.queue.length) state.queue = shuffle(pool.map((q) => q.id));
    const id = state.queue.shift();
    return { kind: 'concept', item: BANK.find((q) => q.id === id) };
  }

  function next() {
    let q = null;
    if (state.mode === 'trace') q = nextTrace();
    else if (state.mode === 'concept') q = nextConcept();
    else q = Math.random() < 0.5 ? nextTrace() || nextConcept() : nextConcept() || nextTrace();
    state.current = q;
    render();
  }

  // ------------------------------------------------------------ number input

  // Possible values for an answer. Hex is the default; a trailing d means
  // decimal, but "846d" is also valid hex, so both readings are returned.
  function parseAnswer(text, size) {
    let s = text.trim().replace(/[\s_]/g, '');
    if (!s) return [];
    let neg = false;
    if (s[0] === '-') { neg = true; s = s.slice(1); }
    const vals = [];
    if (/^\d+d$/i.test(s)) vals.push(BigInt(s.slice(0, -1)));
    if (/^0x[0-9a-f]+$/i.test(s)) vals.push(BigInt(s));
    else if (/^[0-9a-f]+h?$/i.test(s)) vals.push(BigInt('0x' + s.replace(/h$/i, '')));
    return vals.map((v) => (neg ? -v : v) & window.X86.MASK[size]);
  }

  const hexText = (v, size) => v.toString(16).toUpperCase().padStart(size / 4, '0') + 'h';

  // ------------------------------------------------------------ trace card

  function renderTrace(cur) {
    const { topic, q, res } = cur;
    const marks = {};
    q.asks.forEach((a) => { marks[a.line] = a.mark; });

    const code = el('div', { class: 'code' });
    if (q.data && q.data.length) {
      code.append(el('div', { class: 'dir' }, '.data'));
      q.data.forEach((l) => code.append(el('div', { class: 'line' }, el('span', { class: 'src' }, l))));
      code.append(el('div', { class: 'dir' }, '.code'));
    }
    q.code.forEach((l, i) => {
      const isLabel = /^\w+:\s*$/.test(l);
      code.append(el('div', { class: 'line' + (isLabel ? ' label' : '') },
        el('span', { class: 'src' }, l),
        marks[i] ? el('span', { class: 'mark' }, '; (' + marks[i] + ')') : null));
    });

    const fields = [];
    const asks = q.asks.map((a) => {
      const snap = res.steps[a.line];
      const row = el('div', { class: 'ask' }, el('span', { class: 'askmark' }, '(' + a.mark + ')'));
      const body = el('div', { class: 'askbody' });
      row.append(body);
      (a.regs || []).forEach((name) => {
        const want = window.X86.regValue(snap, name);
        const input = el('input', { type: 'text', inputmode: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'hex', 'aria-label': name });
        const fb = el('span', { class: 'fb' });
        body.append(el('label', { class: 'reg' }, el('span', { class: 'rname' }, name + ' ='), input, fb));
        fields.push({
          check() {
            const ok = parseAnswer(input.value, want.size).includes(want.value);
            input.classList.toggle('ok', ok);
            input.classList.toggle('bad', !ok);
            input.disabled = true;
            fb.textContent = ok ? '' : hexText(want.value, want.size);
            return ok;
          },
        });
      });
      if (a.flags) {
        const flagRow = el('div', { class: 'flags' });
        ASK_FLAGS.forEach((f) => {
          const want = snap.flags[f];
          if (want === null) {
            flagRow.append(el('span', { class: 'flag na', title: f + ' is unknown or undefined here' }, f, el('span', { class: 'q' }, '?')));
            return;
          }
          let chosen = null;
          const b0 = el('button', { type: 'button', class: 'bit' }, '0');
          const b1 = el('button', { type: 'button', class: 'bit' }, '1');
          const choose = (v) => {
            chosen = v;
            b0.classList.toggle('on', v === 0);
            b1.classList.toggle('on', v === 1);
          };
          b0.addEventListener('click', () => choose(0));
          b1.addEventListener('click', () => choose(1));
          const box = el('span', { class: 'flag' }, el('span', { class: 'fname' }, f), b0, b1);
          flagRow.append(box);
          fields.push({
            check() {
              const ok = chosen === want;
              box.classList.add(ok ? 'ok' : 'bad');
              (want ? b1 : b0).classList.add('right');
              b0.disabled = b1.disabled = true;
              return ok;
            },
          });
        });
        body.append(flagRow);
      }
      if (a.jump) {
        const want = snap.jumped;
        let chosen = null;
        const yes = el('button', { type: 'button', class: 'pill' }, 'Jumps');
        const no = el('button', { type: 'button', class: 'pill' }, 'Falls through');
        const choose = (v) => {
          chosen = v;
          yes.classList.toggle('on', v === true);
          no.classList.toggle('on', v === false);
        };
        yes.addEventListener('click', () => choose(true));
        no.addEventListener('click', () => choose(false));
        body.append(el('div', { class: 'jump' }, yes, no));
        fields.push({
          check() {
            const ok = chosen === want;
            (want ? yes : no).classList.add('right');
            if (chosen !== null && !ok) (chosen ? yes : no).classList.add('wrong');
            yes.disabled = no.disabled = true;
            return ok;
          },
        });
      }
      return row;
    });

    const notes = el('div', { class: 'notes', hidden: true });
    const regTable = el('div', { class: 'reveal', hidden: true });
    const flagTable = el('div', { class: 'reveal', hidden: true });
    let built = false;
    const reveal = (which, btn) => {
      if (!built) {
        regTable.append(buildRegTable(q, res, marks));
        flagTable.append(buildFlagTable(q, res, marks));
        built = true;
      }
      which.hidden = !which.hidden;
      btn.classList.toggle('on', !which.hidden);
      showNotes();
    };
    const showNotes = () => {
      if (!notes.hidden) return;
      notes.append(buildNotes(q));
      notes.hidden = false;
    };

    cur.check = () => {
      if (cur.checked) return;
      cur.checked = true;
      const ok = fields.map((f) => f.check()).every(Boolean);
      record('t:' + topic.id, ok);
      verdict.textContent = ok ? 'All correct' : 'Not quite. Corrections are shown next to each answer.';
      verdict.className = 'verdict ' + (ok ? 'ok' : 'bad');
      checkBtn.disabled = true;
      showNotes();
    };

    const verdict = el('p', { class: 'verdict' });
    const checkBtn = el('button', { type: 'button', class: 'primary', onclick: () => cur.check() }, 'Check');
    const regBtn = el('button', { type: 'button', class: 'ghost' }, 'Reveal registers');
    const flagBtn = el('button', { type: 'button', class: 'ghost' }, 'Reveal flags');
    regBtn.addEventListener('click', () => reveal(regTable, regBtn));
    flagBtn.addEventListener('click', () => reveal(flagTable, flagBtn));

    return [
      el('div', { class: 'tag' }, 'Ch ' + topic.sec + ' · ' + topic.name),
      el('p', { class: 'prompt' }, 'Trace the code. For each marked line, give the registers in hex (add a trailing d for decimal) and the flags right after it runs.'),
      code,
      el('div', { class: 'asks' }, asks),
      el('div', { class: 'actions' }, checkBtn, el('button', { type: 'button', class: 'ghost', onclick: next }, 'Next'), verdict),
      el('div', { class: 'reveals' }, regBtn, flagBtn),
      regTable,
      flagTable,
      notes,
    ];
  }

  function stepRows(q, res, marks, cells) {
    const rows = [];
    let prev = null;
    q.code.forEach((line, i) => {
      if (!window.X86.parseLine(line).op) return;
      const snap = res.steps[i];
      const tr = el('tr', { class: snap ? '' : 'skipped' },
        el('td', { class: 'mk' }, marks[i] ? '(' + marks[i] + ')' : ''),
        el('td', { class: 'src' }, line));
      if (!snap) {
        tr.append(el('td', { class: 'note', colspan: 99 }, 'not executed'));
      } else {
        cells(snap, prev).forEach((c) => tr.append(c));
        prev = snap;
      }
      rows.push(tr);
    });
    return rows;
  }

  function buildRegTable(q, res, marks) {
    const fams = res.families;
    const mems = res.written;
    const head = el('tr', {}, el('th', {}), el('th', {}, 'after'),
      fams.map((f) => el('th', {}, f.name)), mems.map((m) => el('th', {}, m)));
    const text = (snap, f) => window.X86.familyText(snap, f.fam, f.width, res.vars);
    const memText = (snap, m) => snap.mem[m].map((v) => v.toString(16).toUpperCase().padStart(res.vars[m].type * 2, '0')).join(' ');
    const rows = stepRows(q, res, marks, (snap, prev) => [
      ...fams.map((f) => {
        const t = text(snap, f);
        return el('td', { class: 'val' + (prev && text(prev, f) !== t ? ' chg' : '') }, t);
      }),
      ...mems.map((m) => {
        const t = memText(snap, m);
        return el('td', { class: 'val' + (prev && memText(prev, m) !== t ? ' chg' : '') }, t);
      }),
    ]);
    return el('div', { class: 'tablewrap' },
      el('table', {}, el('thead', {}, head), el('tbody', {}, rows)),
      el('p', { class: 'legend' }, '? = never set in this snippet. Bold = changed by that line. Values are hex.'));
  }

  function buildFlagTable(q, res, marks) {
    const head = el('tr', {}, el('th', {}), el('th', {}, 'after'), window.X86.FLAGS.map((f) => el('th', {}, f)));
    const rows = stepRows(q, res, marks, (snap, prev) => window.X86.FLAGS.map((f) => {
      const v = snap.flags[f];
      const t = v === null ? '?' : String(v);
      const was = prev ? (prev.flags[f] === null ? '?' : String(prev.flags[f])) : null;
      return el('td', { class: 'val' + (v === null ? ' unk' : '') + (was !== null && was !== t ? ' chg' : '') }, t);
    }));
    return el('div', { class: 'tablewrap' },
      el('table', {}, el('thead', {}, head), el('tbody', {}, rows)),
      el('p', { class: 'legend' }, '? = unknown (never set) or undefined after that instruction. Bold = changed by that line.'));
  }

  const RULES = {
    mov: 'MOV changes no flags. Writing AL, AH, or AX leaves the rest of EAX unchanged.',
    movzx: 'MOVZX fills the upper bits with 0. No flags.',
    movsx: 'MOVSX copies the source sign bit into the upper bits. No flags.',
    xchg: 'XCHG swaps its operands. No flags.',
    add: 'ADD: CF = carry out of the MSB. OF = 1 when two same-sign operands give a result of the other sign.',
    sub: 'SUB: CF = borrow (destination < source as unsigned). OF = 1 when the operand signs differ and the result sign differs from the destination.',
    cmp: 'CMP sets the flags exactly like SUB but leaves the destination alone.',
    inc: 'INC and DEC never change CF.',
    dec: 'INC and DEC never change CF.',
    neg: 'NEG: CF = 1 unless the operand was 0. OF = 1 only when negating the most negative value.',
    and: 'AND, OR, XOR, TEST always clear CF and OF; SF, ZF, PF come from the result.',
    or: 'AND, OR, XOR, TEST always clear CF and OF; SF, ZF, PF come from the result.',
    xor: 'AND, OR, XOR, TEST always clear CF and OF; SF, ZF, PF come from the result.',
    test: 'AND, OR, XOR, TEST always clear CF and OF; SF, ZF, PF come from the result.',
    not: 'NOT inverts every bit and changes no flags.',
    shl: 'SHL/SAL: 0 enters at the bottom, CF = last bit out the top. OF (count 1 only) = 1 if the sign bit changed.',
    sal: 'SHL/SAL: 0 enters at the bottom, CF = last bit out the top. OF (count 1 only) = 1 if the sign bit changed.',
    shr: 'SHR: 0 enters at the top, CF = last bit out the bottom. OF (count 1 only) = the original MSB.',
    sar: 'SAR: the sign bit is copied in at the top, CF = last bit out the bottom. OF = 0 for count 1.',
    rol: 'ROL/ROR: bits wrap around; CF gets a copy of the bit that wrapped. Only CF and OF change (OF only for count 1).',
    ror: 'ROL/ROR: bits wrap around; CF gets a copy of the bit that wrapped. Only CF and OF change (OF only for count 1).',
    rcl: 'RCL/RCR rotate through CF as if it were an extra bit. Only CF and OF change.',
    rcr: 'RCL/RCR rotate through CF as if it were an extra bit. Only CF and OF change.',
    shld: 'SHLD/SHRD shift the destination and fill the opened bits from the source. The source does not change.',
    shrd: 'SHLD/SHRD shift the destination and fill the opened bits from the source. The source does not change.',
    mul: 'MUL: AL/AX/EAX times the operand into AX, DX:AX, or EDX:EAX. CF = OF = 1 if the upper half is not 0. SF, ZF, AF, PF undefined.',
    imul: 'IMUL: CF = OF = 1 if the product does not fit (upper half is not just the sign extension of the lower). SF, ZF, AF, PF undefined.',
    div: 'DIV: quotient in AL/AX/EAX, remainder in AH/DX/EDX. All flags undefined.',
    idiv: 'IDIV truncates toward 0 and the remainder takes the sign of the dividend. All flags undefined.',
    cbw: 'CBW, CWD, CDQ copy the sign bit into the upper half (AH, DX, EDX). No flags.',
    cwd: 'CBW, CWD, CDQ copy the sign bit into the upper half (AH, DX, EDX). No flags.',
    cdq: 'CBW, CWD, CDQ copy the sign bit into the upper half (AH, DX, EDX). No flags.',
    adc: 'ADC adds the source plus CF.',
    sbb: 'SBB subtracts the source and CF.',
    stc: 'STC sets CF, CLC clears it. No other flags change.',
    clc: 'STC sets CF, CLC clears it. No other flags change.',
    lahf: 'LAHF: AH bits 7..0 = SF ZF 0 AF 0 PF 1 CF.',
    jecxz: 'JECXZ jumps when ECX = 0 and ignores the flags.',
  };
  const JUMP_RULE = 'Unsigned: JA (CF=0 and ZF=0), JAE (CF=0), JB (CF=1), JBE (CF=1 or ZF=1). Signed: JG (ZF=0 and SF=OF), JGE (SF=OF), JL (SF≠OF), JLE (ZF=1 or SF≠OF).';

  function buildNotes(q) {
    const seen = new Set();
    q.code.forEach((l) => {
      const op = window.X86.parseLine(l).op;
      if (!op) return;
      if (RULES[op]) seen.add(RULES[op]);
      else if (/^j/.test(op) && op !== 'jmp') seen.add(JUMP_RULE);
    });
    if (q.code.some((l) => /\bPTR\b|\[|OFFSET|TYPE|LENGTHOF|SIZEOF/i.test(l))) {
      seen.add('Memory is little-endian: the lowest byte sits at the lowest address. var+n means n bytes, not n elements.');
    }
    return el('div', {}, el('h3', {}, 'Rules in play'), el('ul', {}, [...seen].map((r) => el('li', {}, r))));
  }

  // ------------------------------------------------------------ concept card

  const normalize = (s) => s.toLowerCase().replace(/\s+/g, '');

  function renderConcept(cur) {
    const q = cur.item;
    const why = el('p', { class: 'why', hidden: true });
    const verdict = el('p', { class: 'verdict' });
    const finish = (ok, correctText) => {
      cur.checked = true;
      record('c:' + q.ch, ok);
      if (!ok) state.queue.splice(Math.min(5, state.queue.length), 0, q.id);
      verdict.className = 'verdict ' + (ok ? 'ok' : 'bad');
      verdict.innerHTML = ok ? 'Correct' : 'Answer: ' + rich(correctText);
      if (q.why) {
        why.innerHTML = rich(q.why);
        why.hidden = false;
      }
    };

    let body;
    if (q.type === 'mc' || q.type === 'tf') {
      const options = q.type === 'tf'
        ? [{ text: 'True', ok: q.answer === true }, { text: 'False', ok: q.answer === false }]
        : shuffle(q.choices.map((c, i) => ({ text: c, ok: i === 0 })));
      const buttons = options.map((o) => el('button', { type: 'button', class: 'choice', html: rich(o.text) }));
      buttons.forEach((b, i) => b.addEventListener('click', () => {
        if (cur.checked) return;
        buttons.forEach((x, j) => {
          x.disabled = true;
          if (options[j].ok) x.classList.add('right');
        });
        if (!options[i].ok) b.classList.add('wrong');
        finish(options[i].ok, options.find((o) => o.ok).text);
      }));
      body = el('div', { class: q.type === 'tf' ? 'choices tf' : 'choices' }, buttons);
      cur.check = () => {};
    } else {
      const input = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'your answer', 'aria-label': 'answer' });
      const go = el('button', { type: 'button', class: 'primary' }, 'Check');
      cur.check = () => {
        if (cur.checked || !input.value.trim()) return;
        const ok = q.answer.some((a) => normalize(a) === normalize(input.value));
        input.classList.add(ok ? 'ok' : 'bad');
        input.disabled = true;
        go.disabled = true;
        finish(ok, q.answer[0]);
      };
      go.addEventListener('click', () => cur.check());
      body = el('div', { class: 'fill' }, input, go);
    }

    const kind = { mc: 'Multiple choice', tf: 'True or false', fill: 'Fill in the blank' }[q.type];
    return [
      el('div', { class: 'tag' }, 'Ch ' + q.sec + ' · ' + kind),
      el('p', { class: 'question', html: rich(q.q) }),
      body,
      el('div', { class: 'actions' }, el('button', { type: 'button', class: 'ghost', onclick: next }, 'Next'), verdict),
      why,
    ];
  }

  // ------------------------------------------------------------ stats panel

  function renderStats() {
    const panel = $('#stats');
    panel.innerHTML = '';
    const pct = (s) => (s && s.total ? Math.round((100 * s.right) / s.total) + '%' : '');
    const bar = (s) => el('span', { class: 'bar' }, el('span', { style: 'width:' + (s && s.total ? (100 * s.right) / s.total : 0) + '%' }));
    const rows = TOPICS.map((t) => {
      const s = state.stats['t:' + t.id];
      const box = el('input', { type: 'checkbox', checked: !state.disabled.has(t.id) });
      box.addEventListener('change', () => {
        if (box.checked) state.disabled.delete(t.id);
        else state.disabled.add(t.id);
        save();
      });
      return el('tr', { class: state.chapters.has(t.ch) ? '' : 'off' },
        el('td', {}, el('label', { class: 'topic' }, box, ' ', t.name)),
        el('td', { class: 'sec' }, t.sec),
        el('td', { class: 'num' }, s ? s.right + '/' + s.total : ''),
        el('td', {}, bar(s)),
        el('td', { class: 'num' }, pct(s)));
    });
    const crow = [4, 6, 7].map((ch) => {
      const s = state.stats['c:' + ch];
      return el('tr', {}, el('td', {}, 'Concepts, chapter ' + ch), el('td', { class: 'sec' }, BANK.filter((q) => q.ch === ch).length + ' qs'),
        el('td', { class: 'num' }, s ? s.right + '/' + s.total : ''), el('td', {}, bar(s)), el('td', { class: 'num' }, pct(s)));
    });
    const reset = el('button', { type: 'button', class: 'ghost small' }, 'Reset stats');
    reset.addEventListener('click', () => {
      state.stats = {};
      save();
      renderStats();
    });
    panel.append(
      el('div', { class: 'panelhead' }, el('h2', {}, 'Topics'), reset),
      el('p', { class: 'legend' }, 'Unchecked topics are skipped. Topics you miss more come up more often.'),
      el('table', { class: 'stats' }, el('tbody', {}, rows, crow)));
  }

  // ------------------------------------------------------------ main render

  function render() {
    const card = $('#card');
    card.innerHTML = '';
    const cur = state.current;
    if (!cur) {
      card.append(el('p', { class: 'empty' }, 'Nothing to show. Turn on at least one chapter or topic.'));
      return;
    }
    card.append(...(cur.kind === 'trace' ? renderTrace(cur) : renderConcept(cur)));
    const first = card.querySelector('input:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }

  function syncControls() {
    document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
    document.querySelectorAll('#chapters button').forEach((b) => b.classList.toggle('on', state.chapters.has(Number(b.dataset.ch))));
  }

  document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    save();
    syncControls();
    next();
  }));

  document.querySelectorAll('#chapters button').forEach((b) => b.addEventListener('click', () => {
    const ch = Number(b.dataset.ch);
    if (state.chapters.has(ch)) state.chapters.delete(ch);
    else state.chapters.add(ch);
    save();
    syncControls();
    if (!$('#stats').hidden) renderStats();
    next();
  }));

  $('#statsBtn').addEventListener('click', () => {
    const panel = $('#stats');
    panel.hidden = !panel.hidden;
    $('#statsBtn').classList.toggle('on', !panel.hidden);
    if (!panel.hidden) renderStats();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const cur = state.current;
    if (!cur || (e.target.tagName === 'BUTTON' && !cur.checked)) return;
    e.preventDefault();
    if (cur.checked) next();
    else cur.check();
  });

  persist.load().then((saved) => {
    restore(saved);
    setStatus(persist.remote ? 'saved' : 'local');
    syncControls();
    next();
  });
})();
