'use strict';
const test = require('node:test');
const assert = require('node:assert');
const X86 = require('../js/x86.js');

// Runs code and returns a helper for reading the state after line i.
function trace(code, data = []) {
  const res = X86.run({ data, code });
  return {
    res,
    reg: (i, name) => X86.regValue(res.steps[i], name).text,
    flags: (i) => res.steps[i].flags,
    ran: (i) => res.steps[i] !== null,
  };
}

function flagsOf(t, i, names) {
  const f = t.flags(i);
  return Object.fromEntries(names.map((n) => [n, f[n]]));
}

test('partial register writes leave the rest of EAX alone', () => {
  const t = trace(['mov eax,1002FFFFh', 'inc ax', 'mov eax,1002FFFFh', 'neg ax']);
  assert.strictEqual(t.reg(1, 'EAX'), '10020000');
  assert.strictEqual(t.flags(1).ZF, 1);
  assert.strictEqual(t.flags(1).CF, null, 'INC never sets CF, so it stays unknown');
  assert.strictEqual(t.reg(3, 'EAX'), '10020001');
  assert.strictEqual(t.flags(3).CF, 1);
});

test('unknown upper bits show as ?', () => {
  const t = trace(['mov al,5']);
  assert.strictEqual(t.reg(0, 'EAX'), '??????05');
});

test('SUB sets SF and CF on borrow', () => {
  const t = trace(['mov eax,5', 'sub eax,6']);
  assert.strictEqual(t.reg(1, 'EAX'), 'FFFFFFFF');
  assert.deepStrictEqual(flagsOf(t, 1, ['CF', 'SF', 'ZF', 'OF']), { CF: 1, SF: 1, ZF: 0, OF: 0 });
});

test('carry and overflow table', () => {
  let t = trace(['mov eax,0', 'sub eax,1']);
  assert.deepStrictEqual(flagsOf(t, 1, ['CF', 'OF']), { CF: 1, OF: 0 });
  t = trace(['mov dl,7Fh', 'add dl,1']);
  assert.deepStrictEqual(flagsOf(t, 1, ['CF', 'OF']), { CF: 0, OF: 1 });
  t = trace(['mov ax,5', 'mov si,4', 'add si,ax']);
  assert.deepStrictEqual(flagsOf(t, 2, ['CF', 'OF']), { CF: 0, OF: 0 });
  t = trace(['mov cl,80h', 'mov dl,80h', 'add cl,dl']);
  assert.deepStrictEqual(flagsOf(t, 2, ['CF', 'OF', 'ZF']), { CF: 1, OF: 1, ZF: 1 });
});

test('NEG of the minimum value overflows', () => {
  const t = trace(['mov al,80h', 'neg al', 'mov bl,0', 'neg bl']);
  assert.strictEqual(t.reg(1, 'AL'), '80');
  assert.deepStrictEqual(flagsOf(t, 1, ['CF', 'OF']), { CF: 1, OF: 1 });
  assert.deepStrictEqual(flagsOf(t, 3, ['CF', 'ZF']), { CF: 0, ZF: 1 });
});

test('INC keeps a known CF', () => {
  const t = trace(['mov al,0FFh', 'stc', 'inc al']);
  assert.strictEqual(t.reg(2, 'AL'), '00');
  assert.deepStrictEqual(flagsOf(t, 2, ['CF', 'ZF']), { CF: 1, ZF: 1 });
});

test('MOVSX and MOVZX', () => {
  const data = ['one WORD 8002h', 'two WORD 4321h'];
  const t = trace(['mov edx,21348041h', 'movsx edx,one', 'movsx edx,two', 'mov bl,0F0h', 'movzx ecx,bl', 'movsx dx,bl'], data);
  assert.strictEqual(t.reg(1, 'EDX'), 'FFFF8002');
  assert.strictEqual(t.reg(2, 'EDX'), '00004321');
  assert.strictEqual(t.reg(4, 'ECX'), '000000F0');
  assert.strictEqual(t.reg(5, 'EDX'), '0000FFF0');
});

test('PTR and little-endian memory', () => {
  let t = trace(['mov ax,3', 'mov WORD PTR dVal+2,ax', 'mov eax,dVal'], ['dVal DWORD 12345678h']);
  assert.strictEqual(t.reg(2, 'EAX'), '00035678');
  assert.deepStrictEqual(t.res.written, ['dVal']);
  t = trace(['mov dx,WORD PTR myBytes', 'mov eax,DWORD PTR myBytes', 'mov bx,WORD PTR myBytes+1'], ['myBytes BYTE 10h,20h,30h,40h']);
  assert.strictEqual(t.reg(0, 'DX'), '2010');
  assert.strictEqual(t.reg(1, 'EAX'), '40302010');
  assert.strictEqual(t.reg(2, 'BX'), '3020');
});

test('TYPE, LENGTHOF, SIZEOF', () => {
  const data = [
    'myBytes BYTE 10h,20h,30h,40h',
    'myWords WORD 3 DUP(?),2000h',
    'myString BYTE "ABCDE"',
    'nested BYTE 5 DUP(3 DUP(?))',
    'withNull BYTE "ABC",0',
  ];
  const t = trace([
    'mov eax,LENGTHOF myBytes', 'mov eax,TYPE myWords', 'mov eax,SIZEOF myWords',
    'mov eax,SIZEOF myString', 'mov eax,LENGTHOF nested', 'mov eax,SIZEOF withNull',
  ], data);
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map((i) => parseInt(t.reg(i, 'EAX'), 16)), [4, 2, 8, 5, 15, 4]);
});

test('indirect, indexed, and scaled operands', () => {
  const data = ['arr DWORD 100h,200h,300h,400h', 'p DWORD arr'];
  const t = trace([
    'mov esi,OFFSET arr', 'add esi,TYPE arr', 'mov eax,[esi]', 'mov ecx,2',
    'mov ebx,arr[ecx*TYPE arr]', 'mov edx,arr[ecx]', 'mov edi,p', 'mov eax,[edi+12]',
  ], data);
  assert.strictEqual(t.reg(2, 'EAX'), '00000200');
  assert.strictEqual(t.reg(4, 'EBX'), '00000300');
  assert.strictEqual(t.reg(5, 'EDX'), '02000000', 'arr[ecx] is a byte offset, so it reads across elements');
  assert.strictEqual(t.reg(7, 'EAX'), '00000400');
  assert.strictEqual(X86.familyText(t.res.steps[1], 'SI', 32, t.res.vars), 'OFFSET arr+4');
  assert.strictEqual(X86.familyText(t.res.steps[6], 'DI', 32, t.res.vars), 'OFFSET arr');
});

test('bitwise results and flags', () => {
  const t = trace(['mov bx,0FFFFh', 'and bx,6Bh', 'mov bx,029D6h', 'xor bx,8181h', 'mov al,7Ah', 'not al']);
  assert.strictEqual(t.reg(1, 'BX'), '006B');
  assert.deepStrictEqual(flagsOf(t, 1, ['CF', 'OF']), { CF: 0, OF: 0 });
  assert.strictEqual(t.reg(3, 'BX'), 'A857');
  assert.strictEqual(t.flags(3).SF, 1);
  assert.strictEqual(t.reg(5, 'AL'), '85');
  assert.deepStrictEqual(t.flags(5), t.flags(3), 'NOT leaves the flags alone');
});

test('TEST and CMP flags', () => {
  const t = trace([
    'mov al,00001111b', 'test al,00000010b',
    'mov al,00000110b', 'cmp al,00000101b',
    'mov al,00000101b', 'cmp al,00000111b',
  ]);
  assert.deepStrictEqual(flagsOf(t, 1, ['CF', 'ZF', 'SF']), { CF: 0, ZF: 0, SF: 0 });
  assert.deepStrictEqual(flagsOf(t, 3, ['CF', 'ZF', 'SF']), { CF: 0, ZF: 0, SF: 0 });
  assert.deepStrictEqual(flagsOf(t, 5, ['CF', 'ZF', 'SF']), { CF: 1, ZF: 0, SF: 1 });
});

test('signed and unsigned jumps', () => {
  const run = (cmp, jcc) => {
    const t = trace(['mov edx,1', ...cmp, jcc + ' L1', 'mov edx,0', 'L1:']);
    return { edx: t.reg(t.res.steps.length - 1, 'EDX'), skipped: !t.ran(cmp.length + 2) };
  };
  assert.deepStrictEqual(run(['mov eax,7FFFh', 'cmp eax,8000h'], 'jl'), { edx: '00000001', skipped: true });
  assert.deepStrictEqual(run(['mov eax,7FFFh', 'cmp eax,8000h'], 'jb'), { edx: '00000001', skipped: true });
  assert.deepStrictEqual(run(['mov eax,7FFFh', 'cmp eax,0FFFF8000h'], 'jl'), { edx: '00000000', skipped: false });
  assert.strictEqual(run(['mov eax,-30', 'cmp eax,-50'], 'jg').edx, '00000001');
  assert.strictEqual(run(['mov eax,-42', 'cmp eax,26'], 'ja').edx, '00000001');
  assert.strictEqual(run(['mov ecx,0'], 'jecxz').edx, '00000001');
});

test('jumping on an unknown flag is an error', () => {
  assert.throws(() => X86.run({ code: ['jz L1', 'L1:'] }), /ZF is unknown/);
});

test('shifts and rotates on 0D4h', () => {
  const ops = ['shr al,1', 'sar al,1', 'sar al,4', 'rol al,1', 'ror al,3', 'rol al,7'];
  const want = ['6A', 'EA', 'FD', 'A9', '9A', '6A'];
  ops.forEach((op, i) => assert.strictEqual(trace(['mov al,0D4h', op]).reg(1, 'AL'), want[i], op));
  assert.strictEqual(trace(['stc', 'mov al,0D4h', 'rcl al,1']).reg(2, 'AL'), 'A9');
  const t = trace(['stc', 'mov al,0D4h', 'rcr al,3']);
  assert.strictEqual(t.reg(2, 'AL'), '3A');
  assert.strictEqual(t.flags(2).CF, 1);
  assert.strictEqual(t.flags(2).OF, null, 'OF is undefined for counts above 1');
});

test('shift flags', () => {
  let t = trace(['mov al,80h', 'shl al,1']);
  assert.deepStrictEqual(flagsOf(t, 1, ['CF', 'ZF', 'OF']), { CF: 1, ZF: 1, OF: 1 });
  t = trace(['mov al,81h', 'rol al,1']);
  assert.strictEqual(t.reg(1, 'AL'), '03');
  assert.deepStrictEqual(flagsOf(t, 1, ['CF', 'OF', 'ZF']), { CF: 1, OF: 1, ZF: null });
  t = trace(['mov cl,4', 'mov ax,1234h', 'shl ax,cl']);
  assert.strictEqual(t.reg(2, 'AX'), '2340');
  assert.strictEqual(t.flags(2).CF, 1);
});

test('SHLD and SHRD', () => {
  const t = trace(['mov ax,8000h', 'mov dx,0001h', 'shld dx,ax,1', 'mov bx,0001h', 'mov ax,0', 'shrd ax,bx,1']);
  assert.strictEqual(t.reg(2, 'DX'), '0003');
  assert.strictEqual(t.reg(2, 'AX'), '8000', 'source is unchanged');
  assert.strictEqual(t.reg(5, 'AX'), '8000');
});

test('MUL and IMUL', () => {
  let t = trace(['mov dx,0', 'mov ax,222h', 'mov cx,100h', 'mul cx']);
  assert.strictEqual(t.reg(3, 'AX'), '2200');
  assert.strictEqual(t.reg(3, 'DX'), '0002');
  assert.deepStrictEqual(flagsOf(t, 3, ['CF', 'OF', 'ZF']), { CF: 1, OF: 1, ZF: null });
  t = trace(['mov al,48', 'mov bl,4', 'imul bl']);
  assert.strictEqual(t.reg(2, 'AX'), '00C0');
  assert.strictEqual(t.flags(2).CF, 1, '00C0h is not the sign extension of C0h');
  t = trace(['mov al,-4', 'mov bl,4', 'imul bl']);
  assert.strictEqual(t.reg(2, 'AX'), 'FFF0');
  assert.strictEqual(t.flags(2).CF, 0);
  t = trace(['mov bx,-5', 'imul bx,3', 'mov ecx,4000h', 'imul eax,ecx,40000h']);
  assert.strictEqual(t.reg(1, 'BX'), 'FFF1');
  assert.strictEqual(t.reg(3, 'EAX'), '00000000');
  assert.strictEqual(t.flags(3).OF, 1);
});

test('DIV and IDIV', () => {
  let t = trace(['mov ax,63h', 'mov bl,10h', 'div bl']);
  assert.strictEqual(t.reg(2, 'AX'), '0306');
  assert.strictEqual(t.flags(2).CF, null, 'DIV leaves every flag undefined');
  t = trace(['mov eax,123400h', 'mov edx,0', 'mov ebx,10h', 'div ebx']);
  assert.strictEqual(t.reg(3, 'EAX'), '00012340');
  assert.strictEqual(t.reg(3, 'EDX'), '00000000');
  t = trace(['mov ax,-48', 'cwd', 'mov bx,5', 'idiv bx']);
  assert.strictEqual(t.reg(1, 'DX'), 'FFFF');
  assert.strictEqual(t.reg(3, 'AX'), 'FFF7');
  assert.strictEqual(t.reg(3, 'DX'), 'FFFD', 'remainder takes the sign of the dividend');
  t = trace(['mov al,-48', 'cbw', 'mov eax,-276', 'cdq']);
  assert.strictEqual(t.reg(1, 'AX'), 'FFD0');
  assert.strictEqual(t.reg(3, 'EDX'), 'FFFFFFFF');
});

test('divide errors', () => {
  assert.throws(() => X86.run({ code: ['mov ax,4000h', 'mov dx,500h', 'mov bx,10h', 'div bx'] }), /quotient too large/);
  assert.throws(() => X86.run({ code: ['mov ax,5', 'mov bl,0', 'div bl'] }), /division by zero/);
});

test('ADC, SBB, LAHF', () => {
  let t = trace(['mov bx,5', 'stc', 'mov ax,60h', 'adc bx,ax']);
  assert.strictEqual(t.reg(3, 'BX'), '0066');
  t = trace(['mov ax,0100h', 'sub al,1', 'sbb ah,0']);
  assert.strictEqual(t.reg(2, 'AX'), '00FF');
  t = trace(['mov al,7Fh', 'add al,1', 'lahf']);
  assert.strictEqual(t.reg(2, 'AH'), '92');
});

test('assembler-style errors', () => {
  const bad = (code, data, re) => assert.throws(() => X86.run({ code, data }), re);
  bad(['mov ax,bl'], [], /sizes do not match/);
  bad(['mov a,b'], ['a WORD 1', 'b WORD 2'], /Memory-to-memory/);
  bad(['mov esi,0', 'inc [esi]'], [], /size is unknown/);
  bad(['mov al,300'], [], /too large/);
  bad(['movzx ax,bx'], [], /larger than the source/);
  bad(['mul 5'], [], /immediate/);
  bad(['xchg ax,5'], [], /immediates/);
  bad(['shl ax,bl'], [], /immediate or CL/);
});
