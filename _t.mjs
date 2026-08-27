import protodef from 'protodef';
const pd = new protodef.ProtoDef(false);
pd.addType('my_custom', [
  (buf, off) => ({ value: 1, size: 1 }),
  (v, b, o) => o + 1,
  (v) => 4,
]);
console.log('registered OK');
try {
  console.log('sizeOf(undefined):', pd.sizeOf('my_custom', undefined));
} catch (e) {
  console.log('ERR:', e.constructor.name, '-', e.message);
}
