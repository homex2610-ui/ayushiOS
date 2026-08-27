import protodef from 'protodef';
const pd = new protodef.ProtoDef(false);
pd.addType('my_custom', [(buf,off)=>({value:1,size:1}),(v,b,o)=>o+1,(v)=>4]);
// correct signature: sizeOf(value, fieldInfo)
try {
  console.log('sizeOf:', pd.sizeOf('my_custom', 'my_custom'));
} catch (e) { console.log('ERR:', e.message); }
