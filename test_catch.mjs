try {
  await import('./src/agent/vision/camera.js');
} catch(e) {
  console.log('caught:', e?.constructor?.name, e?.message?.slice(0,80));
}
console.log('survived');
