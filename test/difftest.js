#!/usr/bin/env node
/*
 * Differential test: assembles generated questions with JWasm + Irvine32,
 * runs them under Wine with DumpRegs after every instruction, and compares
 * every known register bit and every defined flag against the emulator.
 *
 * Usage: node test/difftest.js [questionsPerTopic]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const X86 = require('../js/x86.js');
const { TOPICS } = require('../js/generators.js');

const perTopic = Number(process.argv[2] || 25);
const dir = path.join(__dirname, '..', '.difftest');
fs.mkdirSync(dir, { recursive: true });

// 1. Generate questions and run them through the emulator.
const cases = [];
const rejected = {};
for (const t of TOPICS) {
  rejected[t.id] = 0;
  for (let i = 0; i < perTopic; i++) {
    for (let tries = 0; tries < 20; tries++) {
      const q = t.gen();
      try {
        const res = X86.run({ data: q.data || [], code: q.code });
        cases.push({ topic: t.id, q, res });
        break;
      } catch (e) {
        if (!(e instanceof X86.AsmError)) throw e;
        rejected[t.id]++;
      }
    }
  }
}

// 2. Emit one program. Symbols get a per-question prefix so they can't collide.
const dataLines = [];
const codeLines = [];
cases.forEach((c, n) => {
  const labels = c.q.code.map((l) => X86.parseLine(l).label).filter(Boolean);
  const names = Object.keys(c.res.vars).concat(labels);
  const rename = (s) => names.reduce((acc, name) => acc.replace(new RegExp('\\b' + name + '\\b', 'g'), `q${n}_${name}`), s);
  (c.q.data || []).forEach((l) => dataLines.push('  ' + rename(l)));
  codeLines.push(`  ; question ${n} (${c.topic})`);
  c.q.code.forEach((l) => {
    const op = X86.parseLine(l).op;
    // A taken jump would skip a dump placed after it. Jcc changes no state, so dump first.
    const isJump = op && /^j/.test(op);
    if (isJump) codeLines.push('  call DumpRegs');
    codeLines.push('  ' + rename(l));
    if (op && !isJump) codeLines.push('  call DumpRegs');
  });
});
// A one-byte marker at the start of .data tells us the real data address.
const asm = ['INCLUDE Irvine32.inc', '.data', '  diffBase BYTE 0', ...dataLines, '.code', 'main PROC',
  '  mov eax,OFFSET diffBase', '  call DumpRegs', ...codeLines, '  exit', 'main ENDP', 'END main', ''].join('\n');
const src = path.join(dir, 'diff.asm');
fs.writeFileSync(src, asm);

// 3. Build and run on the real CPU.
execFileSync('irvine', ['-c', 'diff.asm'], { cwd: dir, stdio: 'inherit' });
const raw = execFileSync('script', ['-qc', 'WINEDEBUG=-all wine diff.exe', '/dev/null'], {
  cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
});
// eslint-disable-next-line no-control-regex
const out = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
const dumpRe = /EAX=([0-9A-F]{8})\s+EBX=([0-9A-F]{8})\s+ECX=([0-9A-F]{8})\s+EDX=([0-9A-F]{8})\s+ESI=([0-9A-F]{8})\s+EDI=([0-9A-F]{8})[\s\S]*?CF=(\d)\s+SF=(\d)\s+ZF=(\d)\s+OF=(\d)\s+AF=(\d)\s+PF=(\d)/g;
const dumps = [...out.matchAll(dumpRe)].map((m) => ({
  regs: { A: BigInt('0x' + m[1]), B: BigInt('0x' + m[2]), C: BigInt('0x' + m[3]), D: BigInt('0x' + m[4]), SI: BigInt('0x' + m[5]), DI: BigInt('0x' + m[6]) },
  flags: { CF: +m[7], SF: +m[8], ZF: +m[9], OF: +m[10], AF: +m[11], PF: +m[12] },
}));

// 4. Rerun the emulator with the real data addresses, then compare.
const base = dumps.shift().regs.A + 1n;
let addr = base;
cases.forEach((c) => {
  c.res = X86.run({ data: c.q.data || [], code: c.q.code }, { base: addr });
  for (const v of Object.values(c.res.vars)) addr += BigInt(v.length * v.type);
});
const expected = [];
cases.forEach((c) => c.res.order.forEach((line) => expected.push({ c, line })));
const problems = [];
if (dumps.length !== expected.length) {
  problems.push(`dump count: emulator expects ${expected.length}, CPU printed ${dumps.length}`);
}
let checkedRegs = 0;
let checkedFlags = 0;
expected.slice(0, dumps.length).forEach(({ c, line }, i) => {
  const snap = c.res.steps[line];
  const cpu = dumps[i];
  for (const fam of ['A', 'B', 'C', 'D', 'SI', 'DI']) {
    const k = snap.known[fam];
    if (!k) continue;
    checkedRegs++;
    if ((snap.regs[fam] & k) !== (cpu.regs[fam] & k)) {
      problems.push(fmt(c, line, `${fam} emu=${hex(snap.regs[fam], k)} cpu=${hex(cpu.regs[fam], k)}`));
    }
  }
  for (const f of X86.FLAGS) {
    if (snap.flags[f] === null) continue;
    checkedFlags++;
    if (snap.flags[f] !== cpu.flags[f]) problems.push(fmt(c, line, `${f} emu=${snap.flags[f]} cpu=${cpu.flags[f]}`));
  }
});

function hex(v, k) {
  return X86.regValue({ regs: { A: v }, known: { A: k } }, 'EAX').text;
}

function fmt(c, line, what) {
  const code = c.q.code.map((l, i) => (i === line ? '> ' : '  ') + l).join('\n      ');
  return `[${c.topic}] ${what}\n      ${(c.q.data || []).join('\n      ')}\n      ${code}`;
}

console.log(`questions: ${cases.length}, instructions: ${expected.length}, dumps: ${dumps.length}`);
console.log(`checked: ${checkedRegs} register values, ${checkedFlags} flags`);
const rej = Object.entries(rejected).filter(([, n]) => n);
if (rej.length) console.log('regenerated after emulator errors:', rej.map(([t, n]) => `${t}=${n}`).join(' '));
if (problems.length) {
  console.log(`\n${problems.length} mismatch(es):`);
  problems.slice(0, 25).forEach((p) => console.log('- ' + p));
  process.exit(1);
}
console.log('all match');
