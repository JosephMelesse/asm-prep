/*
 * A small 32-bit x86 emulator for exam-style trace questions.
 * Covers the Irvine textbook instructions from chapters 4, 6, and 7.
 * Loads as a classic script (window.X86) or as a Node module.
 */
(function (root) {
  'use strict';

  const MASK = { 8: 0xFFn, 16: 0xFFFFn, 32: 0xFFFFFFFFn };
  const TYPE_SIZE = { BYTE: 1, SBYTE: 1, WORD: 2, SWORD: 2, DWORD: 4, SDWORD: 4 };
  const DATA_BASE = 0x00404000n;
  const FAMILIES = ['A', 'B', 'C', 'D', 'SI', 'DI'];
  const FLAGS = ['CF', 'ZF', 'SF', 'OF', 'AF', 'PF'];

  const REG = {};
  [['A', 'EAX', 'AX', 'AL', 'AH'], ['B', 'EBX', 'BX', 'BL', 'BH'],
    ['C', 'ECX', 'CX', 'CL', 'CH'], ['D', 'EDX', 'DX', 'DL', 'DH']].forEach(([f, e, x, l, h]) => {
    REG[e] = { fam: f, shift: 0n, size: 32 };
    REG[x] = { fam: f, shift: 0n, size: 16 };
    REG[l] = { fam: f, shift: 0n, size: 8 };
    REG[h] = { fam: f, shift: 8n, size: 8 };
  });
  REG.ESI = { fam: 'SI', shift: 0n, size: 32 };
  REG.SI = { fam: 'SI', shift: 0n, size: 16 };
  REG.EDI = { fam: 'DI', shift: 0n, size: 32 };
  REG.DI = { fam: 'DI', shift: 0n, size: 16 };

  const FAMILY_NAMES = {
    A: { 8: 'AL', 16: 'AX', 32: 'EAX' }, B: { 8: 'BL', 16: 'BX', 32: 'EBX' },
    C: { 8: 'CL', 16: 'CX', 32: 'ECX' }, D: { 8: 'DL', 16: 'DX', 32: 'EDX' },
    SI: { 16: 'SI', 32: 'ESI' }, DI: { 16: 'DI', 32: 'EDI' },
  };

  class AsmError extends Error {}

  const msb = (v, w) => Number((v >> BigInt(w - 1)) & 1n);
  const toSigned = (v, w) => (msb(v, w) ? v - (1n << BigInt(w)) : v);

  function parity(v) {
    let b = Number(v & 0xFFn);
    let c = 0;
    while (b) { c += b & 1; b >>= 1; }
    return c % 2 === 0 ? 1 : 0;
  }

  // ---------------------------------------------------------------- parsing

  function parseNumber(tok) {
    const t = tok.toUpperCase();
    if (/^[0-9][0-9A-F]*H$/.test(t)) return BigInt('0x' + t.slice(0, -1));
    if (/^[01]+B$/.test(t)) return BigInt('0b' + t.slice(0, -1));
    if (/^[0-9]+D?$/.test(t)) return BigInt(t.replace(/D$/, ''));
    return null;
  }

  function tokenize(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (/\s/.test(ch)) { i++; continue; }
      if ('[]+-*(),'.includes(ch)) { out.push(ch); i++; continue; }
      if (ch === '"' || ch === "'") {
        const j = s.indexOf(ch, i + 1);
        if (j < 0) throw new AsmError('Unterminated string');
        out.push({ str: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
      const m = /^[A-Za-z0-9_?@$]+/.exec(s.slice(i));
      if (!m) throw new AsmError('Unexpected character: ' + ch);
      out.push(m[0]);
      i += m[0].length;
    }
    return out;
  }

  // Linear expression: c + sum(reg * scale) + addresses of vars.
  class ExprParser {
    constructor(tokens, vars) {
      this.t = tokens;
      this.pos = 0;
      this.vars = vars;
    }

    peek() { return this.t[this.pos]; }
    next() { return this.t[this.pos++]; }
    done() { return this.pos >= this.t.length; }

    expect(tok) {
      if (this.next() !== tok) throw new AsmError('Expected ' + tok);
    }

    variable(name) {
      const v = this.vars[name];
      if (!v) throw new AsmError('Unknown symbol: ' + name);
      return v;
    }

    sum() {
      let left = this.term();
      while (this.peek() === '+' || this.peek() === '-') {
        const sign = this.next() === '+' ? 1n : -1n;
        const right = this.term();
        if (sign < 0n && (right.vars.length || right.regs.length)) {
          throw new AsmError('Cannot subtract a register or variable');
        }
        left = combine(left, right, sign);
      }
      return left;
    }

    term() {
      let left = this.factor();
      while (this.peek() === '*') {
        this.next();
        const right = this.factor();
        left = multiply(left, right);
      }
      return left;
    }

    factor() {
      const tok = this.next();
      if (tok === undefined) throw new AsmError('Unexpected end of operand');
      if (tok === '-') {
        const f = this.factor();
        if (f.regs.length || f.vars.length) throw new AsmError('Cannot negate a register or variable');
        return { ...f, c: -f.c };
      }
      if (tok === '(') {
        const e = this.sum();
        this.expect(')');
        return e;
      }
      if (tok === '[') {
        const e = this.sum();
        this.expect(']');
        return { ...e, mem: true };
      }
      if (typeof tok === 'object') {
        if (tok.str.length !== 1) throw new AsmError('Only single-character literals allowed here');
        return lin(BigInt(tok.str.charCodeAt(0)));
      }
      const n = parseNumber(tok);
      if (n !== null) return lin(n);
      const up = tok.toUpperCase();
      if (up === 'OFFSET') {
        const name = this.next();
        const v = this.variable(name);
        return lin(v.addr);
      }
      if (up === 'TYPE' || up === 'LENGTHOF' || up === 'SIZEOF') {
        const v = this.variable(this.next());
        return lin(BigInt(up === 'TYPE' ? v.type : up === 'LENGTHOF' ? v.length : v.length * v.type));
      }
      if (REG[up]) {
        if (REG[up].size !== 32) throw new AsmError('Only 32-bit registers can address memory');
        return { ...lin(0n), regs: [{ reg: up, scale: 1n }] };
      }
      const v = this.variable(tok);
      let e = { ...lin(v.addr), vars: [tok], mem: true };
      if (this.peek() === '[') {
        this.next();
        const inner = this.sum();
        this.expect(']');
        e = combine(e, inner, 1n);
      }
      return e;
    }
  }

  function lin(c) {
    return { c, regs: [], vars: [], mem: false };
  }

  function combine(a, b, sign) {
    return {
      c: a.c + sign * b.c,
      regs: a.regs.concat(b.regs),
      vars: a.vars.concat(b.vars),
      mem: a.mem || b.mem,
    };
  }

  function multiply(a, b) {
    const constA = !a.regs.length && !a.vars.length;
    const constB = !b.regs.length && !b.vars.length;
    if (!constA && !constB) throw new AsmError('Cannot multiply two registers');
    const [k, e] = constA ? [a.c, b] : [b.c, a];
    if (e.vars.length) throw new AsmError('Cannot scale a variable');
    return { ...e, c: e.c * k, regs: e.regs.map((r) => ({ reg: r.reg, scale: r.scale * k })) };
  }

  function parseOperand(text, vars) {
    let t = text.trim();
    let ptr = null;
    const pm = /^(BYTE|SBYTE|WORD|SWORD|DWORD|SDWORD)\s+PTR\s+(.+)$/i.exec(t);
    if (pm) {
      ptr = TYPE_SIZE[pm[1].toUpperCase()] * 8;
      t = pm[2];
    }
    const up = t.toUpperCase();
    if (REG[up]) {
      if (ptr) throw new AsmError('PTR cannot be applied to a register');
      return { kind: 'reg', name: up, size: REG[up].size };
    }
    const p = new ExprParser(tokenize(t), vars);
    const e = p.sum();
    if (!p.done()) throw new AsmError('Unexpected token: ' + p.peek());
    if (!e.mem && !e.vars.length) {
      if (e.regs.length) throw new AsmError('Register in an immediate expression');
      return { kind: 'imm', value: e.c };
    }
    let base = null;
    let index = null;
    let scale = 1n;
    for (const r of e.regs) {
      if (r.scale === 1n && !base) base = r.reg;
      else if (!index) { index = r.reg; scale = r.scale; }
      else throw new AsmError('Too many registers in address');
    }
    if (![1n, 2n, 4n, 8n].includes(scale)) throw new AsmError('Scale factor must be 1, 2, 4, or 8');
    const varName = e.vars[0] || null;
    const size = ptr || (varName ? vars[varName].type * 8 : null);
    return { kind: 'mem', base, index, scale, disp: e.c, size, varName };
  }

  function splitArgs(s) {
    const out = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (const ch of s) {
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      if (ch === '[' || ch === '(') depth++;
      if (ch === ']' || ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function stripComment(s) {
    let quote = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ';') return s.slice(0, i);
    }
    return s;
  }

  function parseLine(text) {
    let s = stripComment(text).trim();
    let label = null;
    const lm = /^([A-Za-z_@$][\w@$]*):\s*(.*)$/.exec(s);
    if (lm) { label = lm[1]; s = lm[2]; }
    if (!s) return { label, op: null, args: [] };
    const sp = s.search(/\s/);
    const op = (sp < 0 ? s : s.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : s.slice(sp + 1).trim();
    return { label, op, args: rest ? splitArgs(rest) : [] };
  }

  // Initializer list: items separated by commas; an item is a string, '?',
  // a constant expression, or "n DUP(list)".
  function parseInits(tokens, type, vars) {
    const p = new ExprParser(tokens, vars);
    const list = () => {
      const out = [];
      for (;;) {
        out.push(...item());
        if (p.peek() !== ',') return out;
        p.next();
      }
    };
    const item = () => {
      const tok = p.peek();
      if (typeof tok === 'object') {
        p.next();
        if (type !== 1) throw new AsmError('Strings need BYTE');
        return [...tok.str].map((c) => BigInt(c.charCodeAt(0)));
      }
      if (tok === '?') { p.next(); return [null]; }
      const e = p.sum();
      if (e.regs.length) throw new AsmError('Register in data');
      if (typeof p.peek() === 'string' && p.peek().toUpperCase() === 'DUP') {
        p.next();
        p.expect('(');
        const inner = list();
        p.expect(')');
        const out = [];
        for (let i = 0n; i < e.c; i++) out.push(...inner);
        return out;
      }
      return [e.c];
    };
    const out = list();
    if (!p.done()) throw new AsmError('Unexpected token in data: ' + p.peek());
    return out;
  }

  function parseData(lines, base) {
    const vars = {};
    const bytes = new Map();
    let addr = base;
    for (const raw of lines) {
      const line = stripComment(raw).trim();
      if (!line) continue;
      const m = /^([A-Za-z_@$][\w@$]*)\s+(BYTE|SBYTE|WORD|SWORD|DWORD|SDWORD)\s+(.+)$/i.exec(line);
      if (!m) throw new AsmError('Bad data line: ' + raw);
      const type = TYPE_SIZE[m[2].toUpperCase()];
      const elems = parseInits(tokenize(m[3]), type, vars);
      vars[m[1]] = { addr, type, length: elems.length, typeName: m[2].toUpperCase() };
      elems.forEach((v, i) => {
        const val = v === null ? 0n : v;
        const w = type * 8;
        if (val < -(1n << BigInt(w - 1)) || val > MASK[w]) throw new AsmError('Value too large for ' + m[2]);
        writeLE(bytes, addr + BigInt(i * type), val & MASK[w], type);
      });
      addr += BigInt(elems.length * type);
    }
    return { vars, bytes };
  }

  function writeLE(bytes, addr, v, n) {
    for (let i = 0; i < n; i++) bytes.set(addr + BigInt(i), (v >> BigInt(8 * i)) & 0xFFn);
  }

  // ---------------------------------------------------------------- machine

  const JUMPS = {
    je: (f) => f.ZF, jz: (f) => f.ZF, jne: (f) => !f.ZF, jnz: (f) => !f.ZF,
    ja: (f) => !f.CF && !f.ZF, jnbe: (f) => !f.CF && !f.ZF,
    jae: (f) => !f.CF, jnb: (f) => !f.CF, jnc: (f) => !f.CF,
    jb: (f) => f.CF, jnae: (f) => f.CF, jc: (f) => f.CF,
    jbe: (f) => f.CF || f.ZF, jna: (f) => f.CF || f.ZF,
    jg: (f) => !f.ZF && f.SF === f.OF, jnle: (f) => !f.ZF && f.SF === f.OF,
    jge: (f) => f.SF === f.OF, jnl: (f) => f.SF === f.OF,
    jl: (f) => f.SF !== f.OF, jnge: (f) => f.SF !== f.OF,
    jle: (f) => f.ZF || f.SF !== f.OF, jng: (f) => f.ZF || f.SF !== f.OF,
    js: (f) => f.SF, jns: (f) => !f.SF, jo: (f) => f.OF, jno: (f) => !f.OF,
    jp: (f) => f.PF, jpe: (f) => f.PF, jnp: (f) => !f.PF, jpo: (f) => !f.PF,
  };

  class Machine {
    constructor(data) {
      this.vars = data.vars;
      this.bytes = new Map(data.bytes);
      this.regs = {};
      this.known = {};
      this.width = {};
      FAMILIES.forEach((f) => {
        this.regs[f] = 0n;
        this.known[f] = 0n;
        this.width[f] = 0;
      });
      this.flags = {};
      FLAGS.forEach((f) => { this.flags[f] = null; });
      this.written = new Set();
    }

    touch(name) {
      const r = REG[name];
      const w = r.shift ? 16 : r.size;
      if (w > this.width[r.fam]) this.width[r.fam] = w;
    }

    readReg(name) {
      const r = REG[name];
      this.touch(name);
      return (this.regs[r.fam] >> r.shift) & MASK[r.size];
    }

    writeReg(name, v) {
      const r = REG[name];
      this.touch(name);
      const m = MASK[r.size] << r.shift;
      this.regs[r.fam] = (this.regs[r.fam] & ~m) | ((v & MASK[r.size]) << r.shift);
      this.known[r.fam] |= m;
    }

    address(op) {
      let a = op.disp;
      if (op.base) a += this.readReg(op.base);
      if (op.index) a += this.readReg(op.index) * op.scale;
      return a & MASK[32];
    }

    readMem(addr, n) {
      let v = 0n;
      for (let i = 0; i < n; i++) {
        const b = this.bytes.get(addr + BigInt(i));
        if (b === undefined) throw new AsmError('Memory access outside the declared data');
        v |= b << BigInt(8 * i);
      }
      return v;
    }

    writeMem(addr, v, n) {
      for (let i = 0; i < n; i++) {
        const a = addr + BigInt(i);
        if (!this.bytes.has(a)) throw new AsmError('Memory write outside the declared data');
        this.bytes.set(a, (v >> BigInt(8 * i)) & 0xFFn);
        for (const [name, d] of Object.entries(this.vars)) {
          if (a >= d.addr && a < d.addr + BigInt(d.length * d.type)) this.written.add(name);
        }
      }
    }

    get(op, w) {
      if (op.kind === 'reg') return this.readReg(op.name);
      if (op.kind === 'imm') {
        checkImm(op.value, w);
        return op.value & MASK[w];
      }
      return this.readMem(this.address(op), w / 8);
    }

    set(op, w, v) {
      if (op.kind === 'reg') this.writeReg(op.name, v);
      else if (op.kind === 'mem') this.writeMem(this.address(op), v & MASK[w], w / 8);
      else throw new AsmError('Destination cannot be an immediate');
    }

    szp(r, w) {
      this.flags.SF = msb(r, w);
      this.flags.ZF = r === 0n ? 1 : 0;
      this.flags.PF = parity(r);
    }

    arith(kind, a, b, cin, w) {
      const M = MASK[w];
      let r;
      if (kind === 'add') {
        const full = a + b + cin;
        r = full & M;
        this.flags.CF = full > M ? 1 : 0;
        this.flags.OF = msb((a ^ r) & (b ^ r), w);
      } else {
        r = (a - b - cin) & M;
        this.flags.CF = a < b + cin ? 1 : 0;
        this.flags.OF = msb((a ^ b) & (a ^ r), w);
      }
      this.flags.AF = Number(((a ^ b ^ r) >> 4n) & 1n);
      this.szp(r, w);
      return r;
    }

    needCF(op) {
      if (this.flags.CF === null) throw new AsmError('CF is unknown before ' + op);
      return BigInt(this.flags.CF);
    }

    exec(op, args, labels) {
      if (op === 'jmp' || op === 'loop' || op === 'jecxz' || op === 'jcxz' || JUMPS[op]) {
        return this.jump(op, args, labels);
      }
      const a = args.map((s) => parseOperand(s, this.vars));
      const f = this.flags;
      const nargs = (n) => {
        if (a.length !== n) throw new AsmError(op + ' takes ' + n + ' operand' + (n === 1 ? '' : 's'));
      };
      switch (op) {
        case 'mov': {
          nargs(2);
          const w = size2(a[0], a[1]);
          this.set(a[0], w, this.get(a[1], w));
          return null;
        }
        case 'movzx':
        case 'movsx': {
          nargs(2);
          if (a[0].kind !== 'reg') throw new AsmError(op + ' destination must be a register');
          const sw = a[1].size;
          if (a[1].kind === 'imm' || !sw) throw new AsmError(op + ' source must be a sized register or memory');
          if (sw >= a[0].size) throw new AsmError(op + ' destination must be larger than the source');
          let v = this.get(a[1], sw);
          if (op === 'movsx') v = toSigned(v, sw) & MASK[a[0].size];
          this.set(a[0], a[0].size, v);
          return null;
        }
        case 'xchg': {
          nargs(2);
          if (a[0].kind === 'imm' || a[1].kind === 'imm') throw new AsmError('XCHG does not take immediates');
          const w = size2(a[0], a[1]);
          const x = this.get(a[0], w);
          const y = this.get(a[1], w);
          this.set(a[0], w, y);
          this.set(a[1], w, x);
          return null;
        }
        case 'add': case 'sub': case 'adc': case 'sbb': case 'cmp': {
          nargs(2);
          const w = size2(a[0], a[1]);
          const x = this.get(a[0], w);
          const y = this.get(a[1], w);
          const cin = op === 'adc' || op === 'sbb' ? this.needCF(op) : 0n;
          const r = this.arith(op === 'add' || op === 'adc' ? 'add' : 'sub', x, y, cin, w);
          if (op !== 'cmp') this.set(a[0], w, r);
          return null;
        }
        case 'inc': case 'dec': {
          nargs(1);
          const w = size1(a[0]);
          const cf = f.CF;
          const r = this.arith(op === 'inc' ? 'add' : 'sub', this.get(a[0], w), 1n, 0n, w);
          f.CF = cf;
          this.set(a[0], w, r);
          return null;
        }
        case 'neg': {
          nargs(1);
          const w = size1(a[0]);
          const x = this.get(a[0], w);
          this.set(a[0], w, this.arith('sub', 0n, x, 0n, w));
          return null;
        }
        case 'and': case 'or': case 'xor': case 'test': {
          nargs(2);
          const w = size2(a[0], a[1]);
          const x = this.get(a[0], w);
          const y = this.get(a[1], w);
          const r = op === 'or' ? x | y : op === 'xor' ? x ^ y : x & y;
          f.CF = 0;
          f.OF = 0;
          f.AF = null;
          this.szp(r, w);
          if (op !== 'test') this.set(a[0], w, r);
          return null;
        }
        case 'not': {
          nargs(1);
          const w = size1(a[0]);
          this.set(a[0], w, ~this.get(a[0], w) & MASK[w]);
          return null;
        }
        case 'shl': case 'sal': case 'shr': case 'sar':
        case 'rol': case 'ror': case 'rcl': case 'rcr':
          nargs(2);
          this.shift(op, a[0], a[1]);
          return null;
        case 'shld': case 'shrd':
          nargs(3);
          this.doubleShift(op, a);
          return null;
        case 'mul': case 'div': case 'idiv':
          nargs(1);
          if (op === 'mul') this.mul(a[0], false);
          else this.div(a[0], op === 'idiv');
          return null;
        case 'imul':
          if (a.length === 1) this.mul(a[0], true);
          else this.imulN(a);
          return null;
        case 'cbw':
          this.writeReg('AX', toSigned(this.readReg('AL'), 8));
          return null;
        case 'cwd':
          this.writeReg('DX', msb(this.readReg('AX'), 16) ? 0xFFFFn : 0n);
          return null;
        case 'cdq':
          this.writeReg('EDX', msb(this.readReg('EAX'), 32) ? MASK[32] : 0n);
          return null;
        case 'stc': f.CF = 1; return null;
        case 'clc': f.CF = 0; return null;
        case 'cmc': f.CF = Number(this.needCF(op)) ^ 1; return null;
        case 'lahf': {
          for (const k of ['SF', 'ZF', 'AF', 'PF', 'CF']) {
            if (f[k] === null) throw new AsmError(k + ' is unknown before LAHF');
          }
          const ah = (f.SF << 7) | (f.ZF << 6) | (f.AF << 4) | (f.PF << 2) | 2 | f.CF;
          this.writeReg('AH', BigInt(ah));
          return null;
        }
        case 'sahf': {
          const ah = Number(this.readReg('AH'));
          f.SF = (ah >> 7) & 1;
          f.ZF = (ah >> 6) & 1;
          f.AF = (ah >> 4) & 1;
          f.PF = (ah >> 2) & 1;
          f.CF = ah & 1;
          return null;
        }
        default:
          throw new AsmError('Unsupported instruction: ' + op);
      }
    }

    jump(op, args, labels) {
      const target = args[0];
      if (!(target in labels)) throw new AsmError('Unknown label: ' + target);
      if (op === 'jmp') return target;
      if (op === 'loop') {
        const c = (this.readReg('ECX') - 1n) & MASK[32];
        this.writeReg('ECX', c);
        return c !== 0n ? target : null;
      }
      if (op === 'jecxz') return this.readReg('ECX') === 0n ? target : null;
      if (op === 'jcxz') return this.readReg('CX') === 0n ? target : null;
      const f = this.flags;
      const guard = new Proxy(f, {
        get(t, k) {
          if (t[k] === null) throw new AsmError(k + ' is unknown before ' + op);
          return t[k];
        },
      });
      return JUMPS[op](guard) ? target : null;
    }

    shift(op, d, cntOp) {
      const w = size1(d);
      if (cntOp.kind === 'reg' && cntOp.name !== 'CL') throw new AsmError('Shift count must be an immediate or CL');
      if (cntOp.kind === 'mem') throw new AsmError('Shift count must be an immediate or CL');
      const c = Number(this.get(cntOp, 8) & 31n);
      if (c === 0) return;
      const f = this.flags;
      const v = this.get(d, w);
      const M = MASK[w];
      const W = BigInt(w);
      const C = BigInt(c);
      let r;
      switch (op) {
        case 'shl': case 'sal':
          r = (v << C) & M;
          f.CF = c < w ? Number((v >> (W - C)) & 1n) : null;
          f.OF = c === 1 ? msb(r, w) ^ f.CF : null;
          f.AF = null;
          this.szp(r, w);
          break;
        case 'shr':
          r = v >> C;
          f.CF = c < w ? Number((v >> (C - 1n)) & 1n) : null;
          f.OF = c === 1 ? msb(v, w) : null;
          f.AF = null;
          this.szp(r, w);
          break;
        case 'sar': {
          const s = toSigned(v, w);
          r = (s >> C) & M;
          f.CF = Number((s >> (C - 1n)) & 1n);
          f.OF = c === 1 ? 0 : null;
          f.AF = null;
          this.szp(r, w);
          break;
        }
        case 'rol': case 'ror': {
          const t = BigInt(c % w);
          if (op === 'rol') {
            r = t ? ((v << t) | (v >> (W - t))) & M : v;
            f.CF = Number(r & 1n);
            f.OF = c === 1 ? msb(r, w) ^ f.CF : null;
          } else {
            r = t ? ((v >> t) | (v << (W - t))) & M : v;
            f.CF = msb(r, w);
            f.OF = c === 1 ? msb(r, w) ^ msb(r, w - 1) : null;
          }
          break;
        }
        default: { // rcl, rcr
          let cf = this.needCF(op);
          const t = w === 32 ? c : c % (w + 1);
          r = v;
          for (let i = 0; i < t; i++) {
            if (op === 'rcl') {
              const out = (r >> (W - 1n)) & 1n;
              r = ((r << 1n) | cf) & M;
              cf = out;
            } else {
              const out = r & 1n;
              r = (r >> 1n) | (cf << (W - 1n));
              cf = out;
            }
          }
          f.CF = Number(cf);
          f.OF = c === 1 ? msb(r, w) ^ (op === 'rcl' ? f.CF : msb(r, w - 1)) : null;
        }
      }
      this.set(d, w, r);
    }

    doubleShift(op, a) {
      const [d, s, cntOp] = a;
      const w = size1(d);
      if (w === 8) throw new AsmError(op + ' needs 16- or 32-bit operands');
      if (s.kind !== 'reg' || s.size !== w) throw new AsmError(op + ' source must be a register of the same size');
      if (cntOp.kind === 'mem' || (cntOp.kind === 'reg' && cntOp.name !== 'CL')) {
        throw new AsmError('Shift count must be an immediate or CL');
      }
      const c = Number(this.get(cntOp, 8) & 31n);
      if (c === 0) return;
      if (c > w) throw new AsmError('Count larger than the operand size gives an undefined result');
      const v = this.get(d, w);
      const src = this.get(s, w);
      const M = MASK[w];
      const W = BigInt(w);
      const C = BigInt(c);
      const f = this.flags;
      let r;
      if (op === 'shld') {
        r = ((v << C) | (src >> (W - C))) & M;
        f.CF = Number((v >> (W - C)) & 1n);
      } else {
        r = ((v >> C) | (src << (W - C))) & M;
        f.CF = Number((v >> (C - 1n)) & 1n);
      }
      f.OF = c === 1 ? msb(r, w) ^ msb(v, w) : null;
      f.AF = null;
      this.szp(r, w);
      this.set(d, w, r);
    }

    accumulator(w) {
      return w === 8 ? ['AL', 'AH', 'AX'] : w === 16 ? ['AX', 'DX'] : ['EAX', 'EDX'];
    }

    mul(src, signed) {
      if (src.kind === 'imm') throw new AsmError('MUL/IMUL with one operand cannot take an immediate');
      const w = size1(src);
      const W = BigInt(w);
      const x = this.readReg(this.accumulator(w)[0]);
      const y = this.get(src, w);
      const p = signed ? toSigned(x, w) * toSigned(y, w) : x * y;
      const lo = p & MASK[w];
      const hi = (p >> W) & MASK[w];
      if (w === 8) this.writeReg('AX', p & 0xFFFFn);
      else {
        const [l, h] = this.accumulator(w);
        this.writeReg(l, lo);
        this.writeReg(h, hi);
      }
      const over = signed ? p !== toSigned(lo, w) : hi !== 0n;
      this.flags.CF = this.flags.OF = over ? 1 : 0;
      this.flags.SF = this.flags.ZF = this.flags.AF = this.flags.PF = null;
    }

    imulN(a) {
      if (a.length > 3) throw new AsmError('IMUL takes at most three operands');
      const d = a[0];
      if (d.kind !== 'reg' || d.size === 8) throw new AsmError('IMUL destination must be a 16- or 32-bit register');
      const w = d.size;
      let x;
      let y;
      if (a.length === 2) {
        size2(d, a[1]);
        x = this.get(d, w);
        y = this.get(a[1], w);
      } else {
        if (a[2].kind !== 'imm') throw new AsmError('Third IMUL operand must be an immediate');
        if (a[1].kind === 'imm') throw new AsmError('Second IMUL operand must be a register or memory');
        size2(d, a[1]);
        x = this.get(a[1], w);
        y = this.get(a[2], w);
      }
      const p = toSigned(x, w) * toSigned(y, w);
      const r = p & MASK[w];
      this.set(d, w, r);
      this.flags.CF = this.flags.OF = p !== toSigned(r, w) ? 1 : 0;
      this.flags.SF = this.flags.ZF = this.flags.AF = this.flags.PF = null;
    }

    div(src, signed) {
      if (src.kind === 'imm') throw new AsmError('DIV/IDIV cannot take an immediate');
      const w = size1(src);
      const W = BigInt(w);
      const d = this.get(src, w);
      if (d === 0n) throw new AsmError('Divide error: division by zero');
      let n;
      if (w === 8) n = this.readReg('AX');
      else {
        const [l, h] = this.accumulator(w);
        n = (this.readReg(h) << W) | this.readReg(l);
      }
      let q;
      let r;
      if (signed) {
        const sn = toSigned(n, w * 2);
        const sd = toSigned(d, w);
        q = sn / sd;
        r = sn % sd;
        if (q < -(1n << (W - 1n)) || q > (1n << (W - 1n)) - 1n) throw new AsmError('Divide error: quotient too large');
      } else {
        q = n / d;
        r = n % d;
        if (q > MASK[w]) throw new AsmError('Divide error: quotient too large');
      }
      if (w === 8) {
        this.writeReg('AL', q & 0xFFn);
        this.writeReg('AH', r & 0xFFn);
      } else {
        const [l, h] = this.accumulator(w);
        this.writeReg(l, q & MASK[w]);
        this.writeReg(h, r & MASK[w]);
      }
      FLAGS.forEach((k) => { this.flags[k] = null; });
    }

    snapshot() {
      const mem = {};
      for (const name of Object.keys(this.vars)) {
        const v = this.vars[name];
        const elems = [];
        for (let i = 0; i < v.length; i++) elems.push(this.readMem(v.addr + BigInt(i * v.type), v.type));
        mem[name] = elems;
      }
      return {
        regs: { ...this.regs },
        known: { ...this.known },
        flags: { ...this.flags },
        mem,
      };
    }
  }

  function checkImm(v, w) {
    if (v < -(1n << BigInt(w - 1)) || v > MASK[w]) throw new AsmError('Constant too large for a ' + w + '-bit operand');
  }

  function size1(op) {
    if (op.kind === 'imm') throw new AsmError('Operand cannot be an immediate');
    if (!op.size) throw new AsmError('Operand size is unknown (use PTR)');
    return op.size;
  }

  function size2(d, s) {
    if (d.kind === 'imm') throw new AsmError('Destination cannot be an immediate');
    if (d.kind === 'mem' && s.kind === 'mem') throw new AsmError('Memory-to-memory operands are not allowed');
    const sd = d.size || null;
    const ss = s.kind === 'imm' ? null : s.size || null;
    if (sd && ss && sd !== ss) throw new AsmError('Operand sizes do not match');
    const w = sd || ss;
    if (!w) throw new AsmError('Operand size is unknown (use PTR)');
    return w;
  }

  // ---------------------------------------------------------------- public

  // Runs a program { data: [lines], code: [lines] }. Returns one snapshot per
  // code line (null for lines that were never executed) plus layout info.
  // opts.base sets the address of the first variable.
  function run(program, opts = {}) {
    const data = parseData(program.data || [], opts.base === undefined ? DATA_BASE : opts.base);
    const m = new Machine(data);
    const lines = program.code.map(parseLine);
    const labels = {};
    lines.forEach((l, i) => { if (l.label) labels[l.label] = i; });
    const steps = lines.map(() => null);
    const order = [];
    let pc = 0;
    let count = 0;
    while (pc < lines.length) {
      if (++count > 2000) throw new AsmError('Too many steps (infinite loop?)');
      const l = lines[pc];
      let target = null;
      if (l.op) {
        try {
          target = m.exec(l.op, l.args, labels);
        } catch (e) {
          if (e instanceof AsmError) e.line = pc;
          throw e;
        }
        order.push(pc);
      }
      steps[pc] = { ...m.snapshot(), jumped: target !== null };
      pc = target !== null ? labels[target] : pc + 1;
    }
    const families = FAMILIES.filter((f) => m.width[f]).map((f) => ({ fam: f, width: m.width[f], name: FAMILY_NAMES[f][m.width[f]] }));
    return { steps, order, families, vars: data.vars, written: [...m.written] };
  }

  function hexDigits(v, known, digits) {
    let s = '';
    for (let i = digits - 1; i >= 0; i--) {
      const sh = BigInt(i * 4);
      s += ((known >> sh) & 0xFn) === 0xFn ? Number((v >> sh) & 0xFn).toString(16).toUpperCase() : '?';
    }
    return s;
  }

  // Value of a named register in a snapshot: { value, known, text }.
  function regValue(snap, name) {
    const r = REG[name.toUpperCase()];
    const value = (snap.regs[r.fam] >> r.shift) & MASK[r.size];
    const k = (snap.known[r.fam] >> r.shift) & MASK[r.size];
    return { value, known: k === MASK[r.size], text: hexDigits(value, k, r.size / 4), size: r.size };
  }

  // Name of the variable a 32-bit value points into, as "OFFSET var+k", or null.
  function pointerText(value, vars) {
    for (const [name, v] of Object.entries(vars)) {
      const off = value - v.addr;
      if (off >= 0n && off < BigInt(v.length * v.type)) return 'OFFSET ' + name + (off ? '+' + off : '');
    }
    return null;
  }

  // Display text for a register family at a width; addresses show symbolically.
  function familyText(snap, fam, width, vars) {
    const r = regValue(snap, FAMILY_NAMES[fam][width]);
    if (width === 32 && r.known) return pointerText(r.value, vars) || r.text;
    return r.text;
  }

  const api = {
    run, parseLine, parseOperand, regValue, familyText, pointerText, toSigned,
    REG, FLAGS, MASK, FAMILY_NAMES, DATA_BASE, AsmError,
  };
  root.X86 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
