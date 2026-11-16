/*
 * Random trace-question generators. Each returns
 *   { data: [lines], code: [lines], asks: [{ line, mark, regs, flags, jump }] }
 * Answers come from running the code through X86.run, never from here.
 */
(function (root) {
  'use strict';

  const rnd = (n) => Math.floor(Math.random() * n);
  const int = (lo, hi) => lo + rnd(hi - lo + 1);
  const pick = (a) => a[rnd(a.length)];
  const chance = (p) => Math.random() < p;

  function hex(n) {
    const s = n.toString(16).toUpperCase();
    return (/^[A-F]/.test(s) ? '0' + s : s) + 'h';
  }
  const bin = (n, w) => n.toString(2).padStart(w, '0') + 'b';

  // Values that tend to expose carry, overflow, and sign mistakes.
  function edge(w) {
    const max = 2 ** w - 1;
    const smin = 2 ** (w - 1);
    switch (rnd(14)) {
      case 0: return 0;
      case 1: return 1;
      case 2: return max;
      case 3: return smin;
      case 4: return smin - 1;
      case 5: return smin + 1;
      case 6: return max - 1;
      case 7: return int(2, 20);
      default: return rnd(max + 1);
    }
  }

  // Immediate text: usually hex, sometimes decimal or negative decimal.
  function imm(v, w) {
    const smin = 2 ** (w - 1);
    if (v >= smin && chance(0.2)) return String(v - 2 ** w);
    if (v < 100 && chance(0.4)) return String(v);
    return hex(v);
  }

  const signed = (w) => {
    const smin = 2 ** (w - 1);
    return pick([-1, -2, smin - 1, -smin, int(-smin, smin - 1), int(-20, 20), int(-200, 200)].filter((v) => v >= -smin && v < smin));
  };

  const ACC = { 8: 'al', 16: 'ax', 32: 'eax' };
  const SECOND = { 8: 'bl', 16: 'bx', 32: 'ebx' };
  const THIRD = { 8: 'cl', 16: 'cx', 32: 'ecx' };
  const width = () => pick([8, 8, 16, 32]);
  const isArith = (s) => /^(inc|dec|neg|add|sub|adc|sbb)\b/.test(s);

  // ----------------------------------------------------------- chapter 4

  function partial() {
    const lo = edge(16);
    const e = rnd(0x10000) * 0x10000 + lo;
    const ops = [
      () => `mov ax,${hex(edge(16))}`, () => `mov al,${hex(edge(8))}`, () => `mov ah,${hex(edge(8))}`,
      () => 'inc ax', () => 'dec ax', () => 'neg ax', () => 'inc al', () => 'dec ah', () => 'neg al',
      () => `add al,${imm(edge(8), 8)}`, () => `sub ax,${imm(edge(16), 16)}`, () => `add ah,${imm(edge(8), 8)}`,
    ];
    const a = pick(ops)();
    const b = pick(ops)();
    return {
      code: [`mov eax,${hex(e)}`, a, b],
      asks: [
        { line: 1, mark: 'a', regs: ['EAX'], flags: isArith(a) },
        { line: 2, mark: 'b', regs: ['EAX'], flags: isArith(b) },
      ],
    };
  }

  function movx() {
    if (chance(0.5)) {
      const ops = ['movsx edx,val1', 'movzx edx,val1', 'movsx edx,val2', 'movzx edx,val2', 'movsx dx,val2', 'movzx dx,val2'];
      const a = pick(ops);
      const b = pick(ops.filter((o) => o !== a));
      return {
        data: [`val1 WORD ${hex(edge(16))}`, `val2 BYTE ${hex(edge(8))}`],
        code: [`mov edx,${hex(rnd(2 ** 32))}`, a, b],
        asks: [{ line: 1, mark: 'a', regs: ['EDX'] }, { line: 2, mark: 'b', regs: ['EDX'] }],
      };
    }
    const src = pick(['bl', 'bh', 'bx']);
    const dst = src === 'bx' ? ['eax', 'ecx'] : pick([['eax', 'ecx'], ['ax', 'cx'], ['eax', 'cx']]);
    const [o1, o2] = chance(0.5) ? ['movsx', 'movzx'] : ['movzx', 'movsx'];
    return {
      code: [`mov ebx,${hex(rnd(2 ** 32))}`, `mov eax,${hex(rnd(2 ** 32))}`, `mov ecx,${hex(rnd(2 ** 32))}`,
        `${o1} ${dst[0]},${src}`, `${o2} ${dst[1]},${src}`],
      asks: [{ line: 3, mark: 'a', regs: ['EAX'] }, { line: 4, mark: 'b', regs: ['ECX'] }],
    };
  }

  function xchg() {
    const ops = ['xchg ah,al', 'xchg al,bl', 'xchg ax,bx', 'xchg bh,al', 'xchg ax,wVal', 'xchg bl,bh'];
    const a = pick(ops);
    const b = pick(ops.filter((o) => o !== a));
    return {
      data: [`wVal WORD ${hex(edge(16))}`],
      code: [`mov ax,${hex(rnd(0x10000))}`, `mov bx,${hex(rnd(0x10000))}`, a, b],
      asks: [{ line: 2, mark: 'a', regs: ['AX', 'BX'] }, { line: 3, mark: 'b', regs: ['AX', 'BX'] }],
    };
  }

  function lahf() {
    const op = pick(['add', 'sub', 'cmp']);
    return {
      code: [`mov al,${hex(edge(8))}`, `${op} al,${imm(edge(8), 8)}`, 'lahf'],
      asks: [
        { line: 1, mark: 'a', regs: op === 'cmp' ? [] : ['AL'], flags: true },
        { line: 2, mark: 'b', regs: ['AH'] },
      ],
    };
  }

  function ptr() {
    const d32 = hex(rnd(2 ** 32));
    switch (rnd(4)) {
      case 0:
        return {
          data: [`dVal DWORD ${d32}`],
          code: [`mov ax,WORD PTR dVal${pick(['', '+2', '+1'])}`, `mov bl,BYTE PTR dVal+${int(0, 3)}`],
          asks: [{ line: 0, mark: 'a', regs: ['AX'] }, { line: 1, mark: 'b', regs: ['BL'] }],
        };
      case 1: {
        const v = pick([`mov ax,${hex(rnd(0x10000))}`, `mov al,${hex(rnd(0x100))}`]);
        const target = v.startsWith('mov ax') ? pick(['WORD PTR dVal', 'WORD PTR dVal+2', 'WORD PTR dVal+1']) : `BYTE PTR dVal+${int(0, 3)}`;
        return {
          data: [`dVal DWORD ${d32}`],
          code: [v, `mov ${target},${v.split(' ')[1].split(',')[0]}`, 'mov eax,dVal'],
          asks: [{ line: 2, mark: 'a', regs: ['EAX'] }],
        };
      }
      case 2: {
        const bytes = Array.from({ length: 4 }, () => hex(rnd(256)));
        return {
          data: [`bArr BYTE ${bytes.join(',')}`],
          code: ['mov eax,DWORD PTR bArr', `mov dx,WORD PTR bArr+${int(0, 2)}`],
          asks: [{ line: 0, mark: 'a', regs: ['EAX'] }, { line: 1, mark: 'b', regs: ['DX'] }],
        };
      }
      default: {
        const words = Array.from({ length: 3 }, () => hex(rnd(0x10000)));
        return {
          data: [`wArr WORD ${words.join(',')}`],
          code: [`mov ax,wArr+${pick([2, 4])}`, `mov ebx,DWORD PTR wArr+${pick([0, 2])}`],
          asks: [{ line: 0, mark: 'a', regs: ['AX'] }, { line: 1, mark: 'b', regs: ['EBX'] }],
        };
      }
    }
  }

  function addsub() {
    const w = width();
    const r = pick({ 8: ['al', 'bl', 'dl', 'ah'], 16: ['ax', 'bx', 'dx'], 32: ['eax', 'ebx', 'edx'] }[w]);
    const op1 = pick(['add', 'sub']);
    const op2 = pick(['add', 'sub']);
    return {
      code: [`mov ${r},${hex(edge(w))}`, `${op1} ${r},${imm(edge(w), w)}`, `${op2} ${r},${imm(edge(w), w)}`],
      asks: [
        { line: 1, mark: 'a', regs: [r.toUpperCase()], flags: true },
        { line: 2, mark: 'b', regs: [r.toUpperCase()], flags: true },
      ],
    };
  }

  function incneg() {
    const w = width();
    const r = ACC[w];
    const ops = ['inc', 'dec', 'neg'];
    const a = pick(ops);
    const b = pick(ops);
    const code = [`mov ${r},${hex(edge(w))}`];
    if (chance(0.7)) code.push(pick(['stc', 'clc']));
    code.push(`${a} ${r}`, `${b} ${r}`);
    const n = code.length;
    return {
      code,
      asks: [
        { line: n - 2, mark: 'a', regs: [r.toUpperCase()], flags: true },
        { line: n - 1, mark: 'b', regs: [r.toUpperCase()], flags: true },
      ],
    };
  }

  function declaration(name) {
    const words = ['ABCDE', 'HELLO', 'x86', 'CIS231', 'ASM', 'Irvine'];
    switch (rnd(9)) {
      case 0: return `${name} BYTE ${Array.from({ length: int(2, 6) }, () => hex(rnd(256))).join(',')}`;
      case 1: return `${name} WORD ${int(2, 5)} DUP(?),${hex(rnd(0x10000))}`;
      case 2: return `${name} DWORD ${int(2, 10)} DUP(0)`;
      case 3: return `${name} BYTE "${pick(words)}",0`;
      case 4: return `${name} BYTE "${pick(words)}"`;
      case 5: return `${name} WORD ${int(2, 4)} DUP(${int(2, 4)} DUP(?))`;
      case 6: return `${name} SDWORD ${Array.from({ length: int(2, 5) }, () => int(-50, -1)).join(',')}`;
      case 7: return `${name} SWORD ${Array.from({ length: int(2, 5) }, () => int(-300, 300)).join(',')}`;
      default: return `${name} DWORD ${Array.from({ length: int(2, 5) }, () => hex(rnd(2 ** 32))).join(',')}`;
    }
  }

  function operators() {
    const names = ['myBytes', 'myWords', 'list', 'arrayD', 'myString', 'table', 'vals'];
    const n1 = pick(names);
    const n2 = pick(names.filter((n) => n !== n1));
    const ops = ['TYPE', 'LENGTHOF', 'SIZEOF'];
    const o1 = pick(ops);
    const o2 = pick(ops.filter((o) => o !== o1));
    return {
      data: [declaration(n1), declaration(n2)],
      code: [`mov eax,${o1} ${n1}`, `mov ebx,${o2} ${chance(0.5) ? n1 : n2}`],
      asks: [{ line: 0, mark: 'a', regs: ['EAX'] }, { line: 1, mark: 'b', regs: ['EBX'] }],
    };
  }

  function indirect() {
    const t = pick([['BYTE', 1, 8], ['WORD', 2, 16], ['DWORD', 4, 32]]);
    const [type, size, w] = t;
    const name = { 1: 'arrB', 2: 'arrW', 4: 'arrD' }[size];
    const vals = Array.from({ length: 4 }, () => hex(rnd(2 ** w)));
    const data = [`${name} ${type} ${vals.join(',')}`];
    const r1 = ACC[w];
    const r2 = SECOND[w];
    switch (rnd(3)) {
      case 0: {
        const step = chance(0.5) ? `add esi,TYPE ${name}` : `add esi,${size * int(1, 2)}`;
        return {
          data,
          code: [`mov esi,OFFSET ${name}`, step, `mov ${r1},[esi]`, `mov ${r2},[esi+${size}]`],
          asks: [{ line: 2, mark: 'a', regs: [r1.toUpperCase()] }, { line: 3, mark: 'b', regs: [r2.toUpperCase()] }],
        };
      }
      case 1: {
        const k = int(0, size === 1 ? 3 : 2);
        return {
          data,
          code: [`mov esi,${k}`, `mov ${r1},${name}[esi*TYPE ${name}]`, `mov ${r2},${name}[esi]`],
          asks: [{ line: 1, mark: 'a', regs: [r1.toUpperCase()] }, { line: 2, mark: 'b', regs: [r2.toUpperCase()] }],
        };
      }
      default:
        return {
          data: data.concat([`ptr1 DWORD ${name}`]),
          code: ['mov esi,ptr1', `mov ${r1},[esi+${size * int(1, 3)}]`],
          asks: [{ line: 1, mark: 'a', regs: [r1.toUpperCase()] }],
        };
    }
  }

  // ----------------------------------------------------------- chapter 6

  function bitwise() {
    const w = width();
    const r = { 8: 'al', 16: 'bx', 32: 'ebx' }[w];
    const fmt = (v) => (w === 8 && chance(0.5) ? bin(v, 8) : hex(v));
    const val = () => (chance(0.3) ? edge(w) : rnd(2 ** w));
    const op1 = pick(['and', 'or', 'xor']);
    const op2 = pick(['and', 'or', 'xor', 'not']);
    const code = [`mov ${r},${fmt(val())}`, `${op1} ${r},${fmt(val())}`];
    if (chance(0.5)) code.push(`mov ${r},${fmt(val())}`);
    code.push(op2 === 'not' ? `not ${r}` : `${op2} ${r},${fmt(val())}`);
    return {
      code,
      asks: [
        { line: 1, mark: 'a', regs: [r.toUpperCase()], flags: true },
        { line: code.length - 1, mark: 'b', regs: [r.toUpperCase()], flags: true },
      ],
    };
  }

  function testcmp() {
    const w = pick([8, 8, 8, 16, 32]);
    const r = ACC[w];
    const fmt = (v) => (w === 8 && chance(0.5) ? bin(v, 8) : imm(v, w));
    const x = edge(w);
    const code = [`mov ${r},${fmt(x)}`, `test ${r},${w === 8 ? bin(1 << rnd(8), 8) : hex(rnd(2 ** w))}`];
    if (chance(0.5)) code.push(`mov ${r},${fmt(edge(w))}`);
    code.push(`cmp ${r},${chance(0.2) ? fmt(x) : fmt(edge(w))}`);
    return {
      code,
      asks: [{ line: 1, mark: 'a', regs: [], flags: true }, { line: code.length - 1, mark: 'b', regs: [], flags: true }],
    };
  }

  const JCC = ['je', 'jne', 'ja', 'jae', 'jb', 'jbe', 'jg', 'jge', 'jl', 'jle'];
  const JCC_RARE = ['jz', 'jnz', 'jc', 'jnc', 'js', 'jns', 'jo', 'jno', 'jnbe', 'jnae', 'jnle', 'jnge', 'jna', 'jng'];

  function jumps() {
    if (chance(0.12)) {
      const c = pick([0, 0, 1, int(2, 9)]);
      return {
        code: ['mov edx,1', `mov ecx,${c}`, 'jecxz L1', 'mov edx,0', 'L1:'],
        asks: [{ line: 2, mark: 'a', jump: true }, { line: 4, mark: 'b', regs: ['EDX'] }],
      };
    }
    const pool = [0, 1, -1, 2, 26, -30, -42, -50, 100, -100, 0x7FFF, 0x8000, 0xFFFF8000, 0x7FFFFFFF, 0x80000000];
    const val = () => (chance(0.6) ? pick(pool) : int(-300, 300));
    const fmt = (v) => (v < 0 ? (chance(0.7) ? String(v) : hex(v + 2 ** 32)) : (v < 1000 && chance(0.5) ? String(v) : hex(v)));
    const x = val();
    const y = chance(0.2) ? x : val();
    const jcc = chance(0.8) ? pick(JCC) : pick(JCC_RARE);
    return {
      code: ['mov edx,1', `mov eax,${fmt(x)}`, `cmp eax,${fmt(y)}`, `${jcc} L1`, 'mov edx,0', 'L1:'],
      asks: [{ line: 2, mark: 'a', flags: true }, { line: 3, mark: 'b', jump: true }],
    };
  }

  // ----------------------------------------------------------- chapter 7

  function shift() {
    const ops = ['shl', 'shr', 'sal', 'sar', 'rol', 'ror'];
    const count = () => pick([1, 1, 1, 2, 3, 4, 5, 7]);
    if (chance(0.25)) {
      const r = pick(['ax', 'bx']);
      const c = int(1, 15);
      return {
        code: [`mov ${r},${hex(rnd(0x10000))}`, `mov cl,${c}`, `${pick(ops)} ${r},cl`],
        asks: [{ line: 2, mark: 'a', regs: [r.toUpperCase()], flags: true }],
      };
    }
    const x = chance(0.5) ? rnd(256) : edge(8);
    const a = pick(ops);
    const b = pick(ops.filter((o) => o !== a));
    const reload = chance(0.7);
    const code = [`mov al,${hex(x)}`, `${a} al,${count()}`];
    if (reload) code.push(`mov al,${hex(x)}`);
    code.push(`${b} al,${count()}`);
    return {
      code,
      asks: [{ line: 1, mark: 'a', regs: ['AL'], flags: true }, { line: code.length - 1, mark: 'b', regs: ['AL'], flags: true }],
    };
  }

  function rcx() {
    const x = chance(0.5) ? rnd(256) : edge(8);
    const part = () => [pick(['stc', 'clc']), `mov al,${hex(x)}`, `${pick(['rcl', 'rcr'])} al,${pick([1, 1, 2, 3, 4])}`];
    const code = part().concat(part());
    return {
      code,
      asks: [{ line: 2, mark: 'a', regs: ['AL'], flags: true }, { line: 5, mark: 'b', regs: ['AL'], flags: true }],
    };
  }

  function shxd() {
    const w = chance(0.7) ? 16 : 32;
    const [r1, r2] = w === 16 ? ['ax', 'dx'] : ['eax', 'edx'];
    const c = () => pick([1, 1, 4, 8, int(1, w - 1)]);
    const first = chance(0.5) ? `shld ${r2},${r1},${c()}` : `shrd ${r2},${r1},${c()}`;
    const second = chance(0.5) ? `shld ${r1},${r2},${c()}` : `shrd ${r1},${r2},${c()}`;
    return {
      code: [`mov ${r1},${hex(rnd(2 ** w))}`, `mov ${r2},${hex(rnd(2 ** w))}`, first, second],
      asks: [
        { line: 2, mark: 'a', regs: [r2.toUpperCase()], flags: true },
        { line: 3, mark: 'b', regs: [r1.toUpperCase()], flags: true },
      ],
    };
  }

  function mul() {
    const w = pick([8, 16, 32]);
    const val = () => pick([edge(w), int(2, 50), 2 ** int(1, w - 1), rnd(2 ** w)]);
    const r = THIRD[w];
    const code = [`mov ${ACC[w]},${hex(val())}`, `mov ${r},${hex(val())}`];
    if (w === 16 && chance(0.5)) code.unshift('mov dx,0');
    code.push(`mul ${r}`);
    const regs = w === 8 ? ['AX'] : w === 16 ? ['AX', 'DX'] : ['EAX', 'EDX'];
    return { code, asks: [{ line: code.length - 1, mark: 'a', regs, flags: true }] };
  }

  function imul() {
    switch (rnd(4)) {
      case 0: {
        const w = pick([8, 16]);
        const regs = w === 8 ? ['AX'] : ['AX', 'DX'];
        return {
          code: [`mov ${ACC[w]},${signed(w)}`, `mov ${SECOND[w]},${signed(w)}`, `imul ${SECOND[w]}`],
          asks: [{ line: 2, mark: 'a', regs, flags: true }],
        };
      }
      case 1:
        return {
          code: [`mov bx,${signed(16)}`, `mov cx,${signed(16)}`, 'imul bx,cx'],
          asks: [{ line: 2, mark: 'a', regs: ['BX'], flags: true }],
        };
      case 2:
        return {
          code: [`mov bx,${signed(16)}`, `imul bx,${int(-20, 20)}`],
          asks: [{ line: 1, mark: 'a', regs: ['BX'], flags: true }],
        };
      default:
        return {
          code: [`mov ebx,${signed(32)}`, `imul eax,ebx,${int(-100, 100)}`],
          asks: [{ line: 1, mark: 'a', regs: ['EAX'], flags: true }],
        };
    }
  }

  function div() {
    const w = pick([8, 16, 32]);
    const max = 2 ** w - 1;
    const d = pick([int(2, 16), 10, 16, int(2, max), 2 ** int(1, w - 1)]);
    const q = pick([int(0, max), int(0, 100)]);
    const r = rnd(d);
    const n = BigInt(q) * BigInt(d) + BigInt(r);
    if (w === 8) {
      return {
        code: [`mov ax,${hex(Number(n))}`, `mov bl,${hex(d)}`, 'div bl'],
        asks: [{ line: 2, mark: 'a', regs: ['AL', 'AH'] }],
      };
    }
    if (w === 16) {
      return {
        code: [`mov dx,${hex(Number(n >> 16n))}`, `mov ax,${hex(Number(n & 0xFFFFn))}`, `mov bx,${hex(d)}`, 'div bx'],
        asks: [{ line: 3, mark: 'a', regs: ['AX', 'DX'] }],
      };
    }
    return {
      code: [`mov edx,${hex(Number(n >> 32n))}`, `mov eax,${hex(Number(n & 0xFFFFFFFFn))}`, `mov ecx,${hex(d)}`, 'div ecx'],
      asks: [{ line: 3, mark: 'a', regs: ['EAX', 'EDX'] }],
    };
  }

  function idiv() {
    const w = pick([8, 16, 32]);
    const ext = { 8: 'cbw', 16: 'cwd', 32: 'cdq' }[w];
    const extReg = { 8: 'AX', 16: 'DX', 32: 'EDX' }[w];
    const x = signed(w);
    let y = 0;
    while (Math.abs(y) < 2) y = pick([int(-12, 12), signed(w)]);
    const out = { 8: ['AL', 'AH'], 16: ['AX', 'DX'], 32: ['EAX', 'EDX'] }[w];
    return {
      code: [`mov ${ACC[w]},${x}`, ext, `mov ${SECOND[w]},${y}`, `idiv ${SECOND[w]}`],
      asks: [{ line: 1, mark: 'a', regs: [extReg] }, { line: 3, mark: 'b', regs: out }],
    };
  }

  function adcsbb() {
    switch (rnd(3)) {
      case 0:
        return {
          code: [`mov bx,${hex(edge(16))}`, pick(['stc', 'clc']), `mov ax,${hex(edge(16))}`, 'adc bx,ax'],
          asks: [{ line: 3, mark: 'a', regs: ['BX'], flags: true }],
        };
      case 1:
        return {
          code: [`mov ax,${hex(rnd(0x10000))}`, `sub al,${imm(edge(8), 8)}`, `sbb ah,${imm(chance(0.6) ? 0 : edge(8), 8)}`],
          asks: [{ line: 1, mark: 'a', regs: ['AX'], flags: true }, { line: 2, mark: 'b', regs: ['AX'], flags: true }],
        };
      default:
        return {
          code: [`mov ax,${hex(rnd(0x10000))}`, `add al,${imm(edge(8), 8)}`, `adc ah,${imm(chance(0.6) ? 0 : edge(8), 8)}`],
          asks: [{ line: 1, mark: 'a', regs: ['AX'], flags: true }, { line: 2, mark: 'b', regs: ['AX'], flags: true }],
        };
    }
  }

  const TOPICS = [
    { id: 'partial', ch: 4, sec: '4.1-4.2', name: 'Partial registers', gen: partial },
    { id: 'movx', ch: 4, sec: '4.1.5', name: 'MOVZX / MOVSX', gen: movx },
    { id: 'lahf', ch: 4, sec: '4.1.6', name: 'LAHF', gen: lahf },
    { id: 'xchg', ch: 4, sec: '4.1.7', name: 'XCHG', gen: xchg },
    { id: 'ptr', ch: 4, sec: '4.1.8, 4.3.3', name: 'Direct-offset and PTR', gen: ptr },
    { id: 'addsub', ch: 4, sec: '4.2', name: 'ADD / SUB flags', gen: addsub },
    { id: 'incneg', ch: 4, sec: '4.2', name: 'INC / DEC / NEG', gen: incneg },
    { id: 'operators', ch: 4, sec: '4.3', name: 'TYPE / LENGTHOF / SIZEOF', gen: operators },
    { id: 'indirect', ch: 4, sec: '4.4', name: 'Indirect and indexed operands', gen: indirect },
    { id: 'bitwise', ch: 6, sec: '6.1', name: 'AND / OR / XOR / NOT', gen: bitwise },
    { id: 'testcmp', ch: 6, sec: '6.1.7-6.1.8', name: 'TEST / CMP flags', gen: testcmp },
    { id: 'jumps', ch: 6, sec: '6.2', name: 'Conditional jumps', gen: jumps },
    { id: 'shift', ch: 7, sec: '7.1', name: 'Shifts and rotates', gen: shift },
    { id: 'rcx', ch: 7, sec: '7.1.7', name: 'RCL / RCR', gen: rcx },
    { id: 'shxd', ch: 7, sec: '7.1.9', name: 'SHLD / SHRD', gen: shxd },
    { id: 'mul', ch: 7, sec: '7.3.1', name: 'MUL', gen: mul },
    { id: 'imul', ch: 7, sec: '7.3.2', name: 'IMUL', gen: imul },
    { id: 'div', ch: 7, sec: '7.3.4', name: 'DIV', gen: div },
    { id: 'idiv', ch: 7, sec: '7.3.5', name: 'IDIV and sign extension', gen: idiv },
    { id: 'adcsbb', ch: 7, sec: '7.4', name: 'ADC / SBB', gen: adcsbb },
  ];

  const api = { TOPICS };
  root.Generators = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
